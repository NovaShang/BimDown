using System.IO;
using System.IO.Compression;
using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using BimDown.RevitAddin.Import;
using BimDown.RevitAddin.Geojson;

namespace BimDown.RevitAddin;

[Transaction(TransactionMode.Manual)]
public class ImportCommand : IExternalCommand
{
    public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
    {
        var doc = commandData.Application.ActiveUIDocument.Document;

        using var dialog = new OpenFileDialog
        {
            Title = L.SelectImportFolder,
            Filter = L.BimDownFileFilter,
            DefaultExt = ".zip",
            InitialDirectory = Path.GetDirectoryName(UserSettings.LastImportPath ?? "") ?? "",
        };

        if (dialog.ShowDialog() != DialogResult.OK)
            return Result.Cancelled;

        UserSettings.LastImportPath = dialog.FileName;

        var tempDir = Path.Combine(Path.GetTempPath(), $"bimdown-import-{Guid.NewGuid():N}");
        try
        {
            ZipFile.ExtractToDirectory(dialog.FileName, tempDir);
            return RunImport(doc, tempDir);
        }
        finally
        {
            try { Directory.Delete(tempDir, true); } catch { }
        }
    }

    static Result RunImport(Document doc, string inputDir)
    {
        var report = ImportFolder(doc, inputDir);
        Autodesk.Revit.UI.TaskDialog.Show("BimDown Import", report.Summary);
        return Result.Succeeded;
    }

    internal sealed record ImportReport(int Tables, int Created, int Updated, int Deleted, List<string> Errors)
    {
        public string Summary
        {
            get
            {
                var msg = $"Import complete ({Tables} tables):\n" +
                          $"  Created: {Created}\n" +
                          $"  Updated: {Updated}\n" +
                          $"  Deleted: {Deleted}";
                if (Errors.Count > 0)
                    msg += $"\n\nErrors ({Errors.Count}):\n" + string.Join("\n", Errors);
                return msg;
            }
        }
    }

    /// <summary>UI-free import of an extracted BimDown folder into <paramref name="doc"/>.</summary>
    internal static ImportReport ImportFolder(Document doc, string inputDir)
    {
        var idMap = new IdMap();
        var allErrors = new List<string>();

        // Ensure BimDown_Id shared parameter exists
        using (var txParam = new Transaction(doc, "BimDown: Ensure parameter"))
        {
            txParam.Start();
            try
            {
                BimDownParameter.EnsureParameter(doc);
                txParam.Commit();
            }
            catch (Exception ex)
            {
                txParam.RollBack();
                allErrors.Add($"Parameter setup: {ex.Message}");
            }
        }

        TableImporterBase[] importers =
        [
            // Order 0
            new LevelImporter(),
            // Order 1
            new GridImporter(),
            // Order 10
            new RoomSeparatorImporter(),
            new WallImporter(),
            new StructureWallImporter(),
            new CurtainWallImporter(),
            new ColumnImporter(),
            new StructureColumnImporter(),
            // Order 15
            new SlabImporter(),
            new RoofImporter(),
            new CeilingImporter(),
            new StructureSlabImporter(),
            new SpaceImporter(),
            new BeamImporter(),
            new BraceImporter(),
            new FoundationImporter(),
            new RampImporter(),
            // Order 16-17 (stairs open their own edit scope; railings follow them)
            new BeamSystemImporter(),
            new StairImporter(),
            new RailingImporter(),
            // Order 20
            new DoorImporter(),
            new WindowImporter(),
            new OpeningImporter(),
            // Order 25
            new DuctImporter(),
            new PipeImporter(),
            new CableTrayImporter(),
            new ConduitImporter(),
            // Order 30
            new EquipmentImporter(),
            new TerminalImporter(),
            new MepNodeImporter(),
            new FurnitureImporter(),
            // Order 35-40
            new CircuitImporter(),
            new AnnotationImporter("text_note"),
            new AnnotationImporter("tag"),
        ];

        foreach (var importer in importers)
            importer.SetIdMap(idMap);

        var sorted = importers.OrderBy(i => i.Order).ToArray();

        var totalCreated = 0;
        var totalUpdated = 0;
        var totalDeleted = 0;
        var tablesProcessed = 0;

        // GeoJSON geometry layer, keyed by "directory/id"
        var geometry = GeoJsonReader.ReadAll(inputDir);

        // Collect all CSV rows per table from level-partitioned directories
        var tableRows = ReadPartitionedCsvs(inputDir);

        // Merge geometry into the CSV rows (CSV values win: opening / landing offsets live in CSV)
        foreach (var (_, rows) in tableRows)
        {
            foreach (var row in rows)
            {
                if (row.GetValueOrDefault("id") is not { } id) continue;
                if (!geometry.TryGetValue($"{row.GetValueOrDefault("_dir") ?? "global"}/{id}", out var fields)) continue;
                foreach (var (key, value) in fields)
                    if (row.GetValueOrDefault(key) is null) row[key] = value;
            }
        }

        AssignLevelsByElevation(tableRows);

        // Types (wall_type, …, type_layer): typed rows inherit their type's values.
        ImportContext.Load(tableRows);
        AnnotationImporter.Reset();

        // _IdMap.csv: uuid → "directory/id" (ids are level-scoped)
        var uuidToIdMap = new Dictionary<string, string>();
        if (tableRows.TryGetValue("_IdMap", out var idMapRows))
        {
            foreach (var row in idMapRows)
            {
                if (row.TryGetValue("uuid", out var uuid) && !string.IsNullOrEmpty(uuid) &&
                    row.TryGetValue("id", out var id) && !string.IsNullOrEmpty(id))
                {
                    var dir = row.GetValueOrDefault("directory") ?? "global";
                    uuidToIdMap[uuid] = $"{dir}/{id}";
                }
            }
        }

        foreach (var importer in sorted)
        {
            if (!tableRows.TryGetValue(importer.TableName, out var rows) || rows.Count == 0)
                continue;

            try
            {
                if (importer.OwnsTransactions)
                {
                    var owned = importer.Import(doc, rows, uuidToIdMap);
                    totalCreated += owned.Created;
                    totalUpdated += owned.Updated;
                    totalDeleted += owned.Deleted;
                    tablesProcessed++;
                    foreach (var error in owned.Errors)
                        allErrors.Add($"[{importer.TableName}] {error}");
                    continue;
                }

                using var tx = new Transaction(doc, $"BimDown Import: {importer.TableName}");
                tx.Start();

                try
                {
                    var result = importer.Import(doc, rows, uuidToIdMap);
                    tx.Commit();

                    totalCreated += result.Created;
                    totalUpdated += result.Updated;
                    totalDeleted += result.Deleted;
                    tablesProcessed++;

                    foreach (var error in result.Errors)
                        allErrors.Add($"[{importer.TableName}] {error}");
                }
                catch (Exception ex)
                {
                    tx.RollBack();
                    allErrors.Add($"[{importer.TableName}] Transaction failed: {ex.Message}");
                }
            }
            catch (Exception ex)
            {
                allErrors.Add($"[{importer.TableName}] Read failed: {ex.Message}");
            }
        }

        AttachWallTops(doc, idMap, allErrors);

        return new ImportReport(tablesProcessed, totalCreated, totalUpdated, totalDeleted, allErrors);
    }

    /// <summary>
    /// Rows in global/ without a level (spatial elements such as beams or terminals that
    /// Revit kept on no level): the highest level at or below their lowest Z.
    /// </summary>
    static void AssignLevelsByElevation(Dictionary<string, List<Dictionary<string, string?>>> tableRows)
    {
        if (!tableRows.TryGetValue("level", out var levelRows)) return;
        var levels = levelRows
            .Select(r => (Id: r.GetValueOrDefault("id"), Elevation: UnitConverter.ParseNullableDouble(r.GetValueOrDefault("elevation"))))
            .Where(l => l.Id is not null && l.Elevation is not null)
            .OrderBy(l => l.Elevation).ToList();
        if (levels.Count == 0) return;
        foreach (var (table, rows) in tableRows)
        {
            if (table is "level" or "grid") continue;
            foreach (var row in rows)
            {
                if (row.GetValueOrDefault("_dir") != "global" || row.GetValueOrDefault("level_id") is not null) continue;
                var zs = new[] { "z", "start_z", "end_z" }
                    .Select(k => UnitConverter.ParseNullableDouble(row.GetValueOrDefault(k))).Where(z => z is not null).Select(z => z!.Value).ToList();
                if (zs.Count == 0) continue;
                var bottom = zs.Min();
                row["level_id"] = levels.LastOrDefault(l => l.Elevation <= bottom + 0.01).Id ?? levels[0].Id;
            }
        }
    }

    /// <summary>Walls with top_attach_id: Attach Top to the roof / floor once every table is in.</summary>
    static void AttachWallTops(Document doc, IdMap idMap, List<string> errors)
    {
        if (ImportContext.PendingAttachments.Count == 0) return;
        using var tx = new Transaction(doc, "BimDown Import: attach wall tops");
        tx.Start();
        foreach (var (wallId, dir, target) in ImportContext.PendingAttachments)
        {
            try
            {
                idMap.CurrentDir = dir;
                if (doc.GetElement(wallId) is not Wall wall || idMap.Resolve(doc, target) is not { } targetId) continue;
                if (wall.GetAttachmentIds(AttachmentLocation.Top).Contains(targetId)) continue;
                wall.AddAttachment(targetId, AttachmentLocation.Top);
            }
            catch (Exception ex)
            {
                errors.Add($"[wall] attach top to {target}: {ex.Message}");
            }
        }
        tx.Commit();
    }

    /// <summary>
    /// Reads CSVs from level-partitioned directories (lv-1/, lv-2/, global/, etc.)
    /// and merges rows per table. For level directories, injects level_id into each row.
    /// Also reads flat CSVs from inputDir root for backwards compatibility.
    /// </summary>
    static Dictionary<string, List<Dictionary<string, string?>>> ReadPartitionedCsvs(string inputDir)
    {
        var result = new Dictionary<string, List<Dictionary<string, string?>>>();

        // Scan subdirectories for partitioned CSVs
        foreach (var subDir in Directory.EnumerateDirectories(inputDir))
        {
            var dirName = Path.GetFileName(subDir);
            var isGlobal = dirName == "global";
            if (dirName is "mesh" or "underlays") continue;

            foreach (var csvFile in Directory.EnumerateFiles(subDir, "*.csv"))
            {
                var tableName = Path.GetFileNameWithoutExtension(csvFile);
                var (_, rows) = CsvReader.Read(csvFile);
                foreach (var row in rows) row["_dir"] = dirName;

                // For non-global level directories, inject level_id from directory name.
                // For global/, fall back to base_level_id (populated by VerticalSpanExtractor)
                // so multi-story elements can still resolve their base level.
                if (!isGlobal)
                {
                    foreach (var row in rows)
                        row["level_id"] = dirName;
                }
                else
                {
                    foreach (var row in rows)
                    {
                        if (row.GetValueOrDefault("level_id") is null &&
                            row.GetValueOrDefault("base_level_id") is { } baseLevelId)
                        {
                            row["level_id"] = baseLevelId;
                        }
                    }
                }

                if (!result.TryGetValue(tableName, out var existing))
                {
                    existing = [];
                    result[tableName] = existing;
                }
                existing.AddRange(rows);
            }
        }

        // Also read flat CSVs from root for backwards compatibility
        foreach (var csvFile in Directory.EnumerateFiles(inputDir, "*.csv"))
        {
            var tableName = Path.GetFileNameWithoutExtension(csvFile);
            if (result.ContainsKey(tableName)) continue; // Partitioned takes priority
            var (_, rows) = CsvReader.Read(csvFile);
            if (rows.Count > 0)
                result[tableName] = rows;
        }

        return result;
    }
}
