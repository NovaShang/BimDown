using Autodesk.Revit.DB;
using BimDown.RevitAddin.Geojson;
using BimDown.RevitAddin.Tables;

namespace BimDown.RevitAddin;

/// <summary>
/// Pure (UI-free) BimDown export pipeline. Lives outside <see cref="ExportCommand"/>
/// — which implements IExternalCommand and therefore drags in RevitAPIUI.dll — so it
/// can be exercised by headless TUnit tests that only have RevitAPI.dll available.
/// </summary>
internal static class ExportPipeline
{
    /// <summary>
    /// Runs the full export pipeline to the specified directory.
    /// Returns the number of exported tables and any errors encountered.
    /// </summary>
    internal static (int TableCount, List<string> Errors) RunExport(
        Document doc, ExportSettings settings, string outputDir)
    {
        var enabled = settings.EnabledTables;

        ITableExporter[] allExporters =
        [
            // Global
            new LevelTableExporter(),
            new GridTableExporter(),
            // Architecture
            ArchitectureTableExporters.Wall(),
            ArchitectureTableExporters.Column(),
            ArchitectureTableExporters.Slab(),
            ArchitectureTableExporters.Space(),
            ArchitectureTableExporters.Door(),
            ArchitectureTableExporters.Window(),
            ArchitectureTableExporters.Stair(),
            ArchitectureTableExporters.CurtainWall(),
            ArchitectureTableExporters.Roof(),
            ArchitectureTableExporters.Ceiling(),
            ArchitectureTableExporters.Opening(),
            ArchitectureTableExporters.Ramp(),
            ArchitectureTableExporters.Railing(),
            ArchitectureTableExporters.RoomSeparator(),
            // Structure
            StructureTableExporters.StructureWall(),
            StructureTableExporters.StructureColumn(),
            StructureTableExporters.StructureSlab(),
            StructureTableExporters.Beam(),
            StructureTableExporters.Brace(),
            StructureTableExporters.Foundation(),
            // MEP
            MepTableExporters.Duct(),
            MepTableExporters.Pipe(),
            MepTableExporters.CableTray(),
            MepTableExporters.Conduit(),
            MepTableExporters.MepNode(),
            MepTableExporters.Equipment(),
            MepTableExporters.Terminal(),
        ];

        var exporters = allExporters.Where(e => enabled.Contains(e.TableName)).ToArray();
        ITableExporter[] withMesh = settings.ExportMesh
            ? [.. exporters, new MeshExporter()]
            : exporters;

        var idGen = new ShortIdGenerator();
        var errors = new List<string>();
        var meshFallback = new MeshFallbackSet();

        foreach (var exp in withMesh)
        {
            if (exp is TableExporter te)
                te.MeshFallback = meshFallback;
        }

        EnsureParameter(doc, errors);
        SeedIds(doc, idGen, errors);
        var exported = ExportTables(doc, withMesh, errors);

        // ID remapping in two passes so references resolve regardless of table order:
        //   1. assign global ids (level, grid)
        //   2. resolve level references (targets now assigned) → enables partitioning
        //   3. assign partitioned ids using the resolved level → directory
        //   4. resolve remaining references (host_id, node ids) after every id exists
        AssignGlobalIds(exported, idGen);
        ResolveLevelReferences(exported, idGen);
        var levelIndex = BuildLevelIndex(exported);
        AssignPartitionedIds(exported, idGen, levelIndex);
        ResolveOtherReferences(exported, idGen);

        if (settings.ExportMesh)
        {
            ExportMeshFiles(outputDir, exported, idGen, errors);
            ExportFallbackMeshFiles(doc, outputDir, exported, idGen, meshFallback, errors);
        }

        WriteCsvs(outputDir, exported, levelIndex, errors);
        WriteIdMap(outputDir, idGen);
        WriteGeometry(outputDir, exported, levelIndex, errors);
        WriteMetadata(outputDir, doc, errors);
        if (settings.WriteIdsToModel)
            WriteIdsToModel(doc, idGen, errors);

        return (exported.Count, errors);
    }

    static void EnsureParameter(Document doc, List<string> errors)
    {
        using var tx = new Transaction(doc, "BimDown: Ensure parameter");
        tx.Start();
        try
        {
            BimDownParameter.EnsureParameter(doc);
            tx.Commit();
        }
        catch (Exception ex)
        {
            tx.RollBack();
            errors.Add($"Parameter setup: {ex.Message}");
        }
    }

    static void SeedIds(Document doc, ShortIdGenerator idGen, List<string> errors)
    {
        foreach (var category in BimDownParameter.AllCategories)
        {
            RunStep($"ID seed ({category})", errors, () =>
            {
                var collector = new FilteredElementCollector(doc)
                    .OfCategory(category)
                    .WhereElementIsNotElementType();
                idGen.SeedFromModel(collector.OrderBy(e => e.Id.Value).ToList());
            });
        }
    }

    static List<(ITableExporter Exporter, List<Dictionary<string, string?>> Rows)> ExportTables(
        Document doc, ITableExporter[] exporters, List<string> errors)
    {
        var exported = new List<(ITableExporter Exporter, List<Dictionary<string, string?>> Rows)>();
        foreach (var exporter in exporters)
        {
            RunStep(exporter.TableName, errors, () =>
            {
                var rows = exporter.Export(doc);
                if (rows.Count > 0)
                    exported.Add((exporter, rows));
            });
        }
        return exported;
    }

    // Pass 1: assign short ids for global tables (level, grid).
    static void AssignGlobalIds(
        List<(ITableExporter Exporter, List<Dictionary<string, string?>> Rows)> exported,
        ShortIdGenerator idGen)
    {
        foreach (var (exporter, rows) in exported)
        {
            if (!exporter.IsGlobal) continue;
            foreach (var row in rows)
                idGen.AssignRowId(exporter.TableName, row, "global");
        }
    }

    // Pass 2: resolve level references on every row (level targets assigned in pass 1).
    static void ResolveLevelReferences(
        List<(ITableExporter Exporter, List<Dictionary<string, string?>> Rows)> exported,
        ShortIdGenerator idGen)
    {
        foreach (var (_, rows) in exported)
            foreach (var row in rows)
                idGen.ResolveLevelReferences(row);
    }

    // Pass 3: assign short ids for partitioned tables using the resolved level id.
    static void AssignPartitionedIds(
        List<(ITableExporter Exporter, List<Dictionary<string, string?>> Rows)> exported,
        ShortIdGenerator idGen, Dictionary<string, int> levelIndex)
    {
        foreach (var (exporter, rows) in exported)
        {
            if (exporter.IsGlobal) continue;
            foreach (var row in rows)
                idGen.AssignRowId(exporter.TableName, row, GetPartitionDir(row, levelIndex));
        }
    }

    // Pass 4: resolve non-level references now that every id has been assigned.
    static void ResolveOtherReferences(
        List<(ITableExporter Exporter, List<Dictionary<string, string?>> Rows)> exported,
        ShortIdGenerator idGen)
    {
        foreach (var (_, rows) in exported)
            foreach (var row in rows)
                idGen.ResolveOtherReferences(row);
    }

    static Dictionary<string, int> BuildLevelIndex(
        List<(ITableExporter Exporter, List<Dictionary<string, string?>> Rows)> exported)
    {
        var levelIndex = new Dictionary<string, int>();
        var levelData = exported.FirstOrDefault(e => e.Exporter.TableName == "level");
        if (levelData.Rows is null) return levelIndex;

        var sorted = levelData.Rows
            .Where(r => r.GetValueOrDefault("id") is not null && r.GetValueOrDefault("elevation") is not null)
            .OrderBy(r => double.Parse(r["elevation"]!, System.Globalization.CultureInfo.InvariantCulture))
            .ToList();
        for (var i = 0; i < sorted.Count; i++)
            levelIndex[sorted[i]["id"]!] = i;

        return levelIndex;
    }

    static void WriteCsvs(string outputDir,
        List<(ITableExporter Exporter, List<Dictionary<string, string?>> Rows)> exported,
        Dictionary<string, int> levelIndex, List<string> errors)
    {
        foreach (var (exporter, rows) in exported)
        {
            if (exporter.IsGlobal)
            {
                var globalDir = Path.Combine(outputDir, "global");
                Directory.CreateDirectory(globalDir);
                var filePath = Path.Combine(globalDir, $"{exporter.TableName}.csv");
                CsvWriter.Write(filePath, exporter.CsvColumns, rows);
            }
            else
            {
                WriteLevelPartitionedCsv(outputDir, exporter, rows, levelIndex);
            }
        }
    }

    static void WriteLevelPartitionedCsv(string outputDir, ITableExporter exporter,
        List<Dictionary<string, string?>> rows, Dictionary<string, int> levelIndex)
    {
        var levelRows = new Dictionary<string, List<Dictionary<string, string?>>>();

        foreach (var row in rows)
        {
            var dirName = GetPartitionDir(row, levelIndex);
            if (!levelRows.TryGetValue(dirName, out var list))
            {
                list = [];
                levelRows[dirName] = list;
            }
            list.Add(row);
        }

        foreach (var (dirName, groupRows) in levelRows)
        {
            var dir = Path.Combine(outputDir, dirName);
            Directory.CreateDirectory(dir);
            var filePath = Path.Combine(dir, $"{exporter.TableName}.csv");
            CsvWriter.Write(filePath, exporter.CsvColumns, groupRows);
        }
    }

    static string GetPartitionDir(Dictionary<string, string?> row, Dictionary<string, int> levelIndex)
    {
        var levelId = row.GetValueOrDefault("level_id");
        var topLevelId = row.GetValueOrDefault("top_level_id");

        var isMultiStory = false;
        if (levelId is not null && topLevelId is not null
            && levelIndex.TryGetValue(levelId, out var baseIdx)
            && levelIndex.TryGetValue(topLevelId, out var topIdx))
        {
            isMultiStory = topIdx - baseIdx > 1;
        }

        return (isMultiStory || levelId is null) ? "global" : levelId;
    }

    static void WriteIdMap(string outputDir, ShortIdGenerator idGen)
    {
        var idMapRows = idGen.Mappings.Select(kvp => new Dictionary<string, string?>
        {
            ["id"] = kvp.Value,
            ["uuid"] = kvp.Key,
            ["directory"] = idGen.GetDirectory(kvp.Value)
        }).ToList();
        CsvWriter.Write(Path.Combine(outputDir, "_IdMap.csv"), ["id", "uuid", "directory"], idMapRows);
    }

    static void ExportMeshFiles(string outputDir,
        List<(ITableExporter Exporter, List<Dictionary<string, string?>> Rows)> exported,
        ShortIdGenerator idGen, List<string> errors)
    {
        var meshData = exported.FirstOrDefault(e => e.Exporter is MeshExporter);
        if (meshData.Exporter is MeshExporter meshExporter && meshData.Rows is not null)
        {
            RunStep("GLB export", errors, () =>
                errors.AddRange(meshExporter.ExportGlbFiles(outputDir, meshData.Rows, idGen.Mappings)));
        }
    }

    /// <summary>
    /// Exports GLB files for elements flagged by exporters as imprecise.
    /// Sets the mesh_file field in the element's existing row.
    /// </summary>
    static void ExportFallbackMeshFiles(Document doc, string outputDir,
        List<(ITableExporter Exporter, List<Dictionary<string, string?>> Rows)> exported,
        ShortIdGenerator idGen, MeshFallbackSet meshFallback, List<string> errors)
    {
        if (meshFallback.Count == 0) return;

        // Build reverse map: short ID → element ID
        var shortIdToElementId = new Dictionary<string, ElementId>();
        foreach (var (uid, shortId) in idGen.Mappings)
        {
            var element = doc.GetElement(uid);
            if (element is not null)
                shortIdToElementId[shortId] = element.Id;
        }

        // Build map: ElementId → (row, shortId) for all exported rows
        var elementIdToRow = new Dictionary<ElementId, (Dictionary<string, string?> Row, string ShortId)>();
        foreach (var (_, rows) in exported)
        {
            foreach (var row in rows)
            {
                var shortId = row.GetValueOrDefault("id");
                if (shortId is null) continue;
                if (shortIdToElementId.TryGetValue(shortId, out var elemId))
                    elementIdToRow.TryAdd(elemId, (row, shortId));
            }
        }

        // Dedup loadable-family meshes by TypeId so e.g. 500 instances of the same
        // air diffuser share one GLB. System families (walls, slabs) keep per-instance
        // world-coord meshes because each carries a unique sketch/profile.
        var typeToMeshPath = new Dictionary<ElementId, string?>();

        RunStep("Mesh fallback GLB", errors, () =>
        {
            foreach (var (elementId, _) in meshFallback.Elements)
            {
                if (!elementIdToRow.TryGetValue(elementId, out var entry)) continue;
                var element = doc.GetElement(elementId);
                if (element is null) continue;

                try
                {
                    string? meshPath;
                    if (element is FamilyInstance)
                    {
                        var typeId = element.GetTypeId();
                        if (typeId != ElementId.InvalidElementId
                            && typeToMeshPath.TryGetValue(typeId, out var cached))
                        {
                            meshPath = cached;
                        }
                        else
                        {
                            // Local coords (origin + rotation from LocationPoint/Curve)
                            // so the typed row's x/y/z/rotation place the GLB.
                            var (origin, rotationRad) = MeshExporter.GetPlacement(element);
                            meshPath = GlbExporter.ExportElement(element, outputDir, entry.ShortId, origin, rotationRad);
                            if (typeId != ElementId.InvalidElementId)
                                typeToMeshPath[typeId] = meshPath;
                        }
                    }
                    else
                    {
                        // System families (Wall, Floor, …): per-instance world coords.
                        meshPath = GlbExporter.ExportElement(element, outputDir, entry.ShortId);
                    }
                    entry.Row["mesh_file"] = meshPath ?? "";
                }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine($"GLB fallback failed for {entry.ShortId}: {ex}");
                }
            }
        });
    }

    static void WriteGeometry(string outputDir,
        List<(ITableExporter Exporter, List<Dictionary<string, string?>> Rows)> exported,
        Dictionary<string, int> levelIndex, List<string> errors)
    {
        var levelData = exported.FirstOrDefault(e => e.Exporter.TableName == "level");
        if (levelData.Rows is null) return;

        // Partition rows using the same multi-story logic as CSV, so geometry lands
        // in the same directory as their CSVs (level dir or global/).
        var partitioned = new List<(string TableName, List<Dictionary<string, string?>> Rows)>();
        foreach (var (exporter, rows) in exported)
        {
            if (exporter.IsGlobal) continue;

            var groups = new Dictionary<string, List<Dictionary<string, string?>>>();
            foreach (var row in rows)
            {
                var dirName = GetPartitionDir(row, levelIndex);
                if (!groups.TryGetValue(dirName, out var list))
                {
                    list = [];
                    groups[dirName] = list;
                }
                list.Add(row);
            }

            foreach (var (dirName, groupRows) in groups)
            {
                // Set level_id to partition dir so GeoJsonWriter groups correctly.
                // Rows are not used after geometry writing.
                foreach (var row in groupRows)
                    row["level_id"] = dirName;
                partitioned.Add((exporter.TableName, groupRows));
            }
        }

        RunStep("GeoJSON export", errors, () =>
            GeoJsonWriter.WriteAll(outputDir, partitioned, levelData.Rows));
    }

    static void WriteMetadata(string outputDir, Document doc, List<string> errors)
    {
        RunStep("Metadata", errors, () =>
        {
            var metadata = new Dictionary<string, string>
            {
                ["format_version"] = "2",
                ["project_name"] = doc.Title ?? "",
                ["units"] = "m",
                ["source"] = $"Revit {doc.Application.VersionNumber}"
            };
            var json = System.Text.Json.JsonSerializer.Serialize(metadata,
                new System.Text.Json.JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(Path.Combine(outputDir, "project_metadata.json"), json);
        });
    }

    static void WriteIdsToModel(Document doc, ShortIdGenerator idGen, List<string> errors)
    {
        using var tx = new Transaction(doc, "BimDown: Write short IDs");
        tx.Start();
        try
        {
            foreach (var (uniqueId, shortId) in idGen.Mappings)
            {
                var element = doc.GetElement(uniqueId);
                if (element is not null)
                    BimDownParameter.Set(element, shortId);
            }
            tx.Commit();
        }
        catch (Exception ex)
        {
            tx.RollBack();
            errors.Add($"Write IDs: {ex.Message}");
        }
    }

    static void RunStep(string name, List<string> errors, Action action)
    {
        try
        {
            action();
        }
        catch (Exception ex)
        {
            errors.Add($"{name}: {ex.Message}");
        }
    }
}
