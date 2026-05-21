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
            new StairImporter(),
            new RampImporter(),
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
        ];

        foreach (var importer in importers)
            importer.SetIdMap(idMap);

        // Sort by order (already ordered in the array, but be explicit)
        var sorted = importers.OrderBy(i => i.Order).ToArray();

        var totalCreated = 0;
        var totalUpdated = 0;
        var totalDeleted = 0;
        var tablesProcessed = 0;

        // Read SVG geometry layer
        var svgGeometry = GeoJsonReader.ReadAll(inputDir);

        // Collect all CSV rows per table from level-partitioned directories
        var tableRows = ReadPartitionedCsvs(inputDir);

        // Parse _IdMap.csv if available to build uuid -> id map
        var uuidToIdMap = new Dictionary<string, string>();
        if (tableRows.TryGetValue("_IdMap", out var idMapRows))
        {
            foreach (var row in idMapRows)
            {
                if (row.TryGetValue("uuid", out var uuid) && !string.IsNullOrEmpty(uuid) &&
                    row.TryGetValue("id", out var id) && !string.IsNullOrEmpty(id))
                {
                    uuidToIdMap[uuid] = id;
                }
            }
        }

        foreach (var importer in sorted)
        {
            if (!tableRows.TryGetValue(importer.TableName, out var rows) || rows.Count == 0)
                continue;

            try
            {
                // Merge SVG geometry fields into CSV rows
                foreach (var row in rows)
                {
                    if (row.TryGetValue("id", out var id) && id is not null
                        && svgGeometry.TryGetValue(id, out var svgFields))
                    {
                        foreach (var (key, value) in svgFields)
                            row[key] = value;
                    }
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

        var msg = $"Import complete ({tablesProcessed} tables):\n" +
                  $"  Created: {totalCreated}\n" +
                  $"  Updated: {totalUpdated}\n" +
                  $"  Deleted: {totalDeleted}";

        if (allErrors.Count > 0)
            msg += $"\n\nErrors ({allErrors.Count}):\n" + string.Join("\n", allErrors);

        Autodesk.Revit.UI.TaskDialog.Show("BimDown Import", msg);
        return Result.Succeeded;
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

            foreach (var csvFile in Directory.EnumerateFiles(subDir, "*.csv"))
            {
                var tableName = Path.GetFileNameWithoutExtension(csvFile);
                var (_, rows) = CsvReader.Read(csvFile);

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
