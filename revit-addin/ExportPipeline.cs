using Autodesk.Revit.DB;
using BimDown.RevitAddin.Tables;

namespace BimDown.RevitAddin;

/// <summary>
/// Pure (UI-free) BimDown export pipeline. Lives outside <see cref="ExportCommand"/>
/// — which implements IExternalCommand and therefore drags in RevitAPIUI.dll — so it
/// can be exercised by headless TUnit tests that only have RevitAPI.dll available.
/// The Revit-independent tail (types, ids, partitioning, CSV / GeoJSON) is
/// <see cref="ProjectWriter"/>.
/// </summary>
internal static class ExportPipeline
{
    /// <summary>Every instance table exporter, in dependency-friendly order.</summary>
    internal static ITableExporter[] AllInstanceExporters() =>
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
        ArchitectureTableExporters.StairRun(),
        ArchitectureTableExporters.StairLanding(),
        ArchitectureTableExporters.CurtainWall(),
        ArchitectureTableExporters.Roof(),
        ArchitectureTableExporters.Ceiling(),
        ArchitectureTableExporters.Opening(),
        ArchitectureTableExporters.Ramp(),
        ArchitectureTableExporters.Railing(),
        ArchitectureTableExporters.RoomSeparator(),
        ArchitectureTableExporters.Furniture(),
        ArchitectureTableExporters.ModelGroup(),
        // Structure
        StructureTableExporters.StructureWall(),
        StructureTableExporters.StructureColumn(),
        StructureTableExporters.StructureSlab(),
        StructureTableExporters.Beam(),
        StructureTableExporters.Brace(),
        StructureTableExporters.BeamSystemTable(),
        StructureTableExporters.Foundation(),
        // MEP
        MepTableExporters.Duct(),
        MepTableExporters.Pipe(),
        MepTableExporters.CableTray(),
        MepTableExporters.Conduit(),
        MepTableExporters.MepNode(),
        MepTableExporters.Equipment(),
        MepTableExporters.Terminal(),
        new ConnectorTableExporter(),
        MepTableExporters.Circuit(),
        MepTableExporters.MepSystem(),
        // Annotation (plan views)
        new AnnotationTableExporter("text_note"),
        new AnnotationTableExporter("tag"),
        new AnnotationTableExporter("dimension"),
    ];

    /// <summary>Tables that follow another table's checkbox (parts of one Revit element family).</summary>
    static readonly Dictionary<string, string> ImpliedBy = new()
    {
        ["stair_run"] = "stair",
        ["stair_landing"] = "stair",
    };

    /// <summary>
    /// Runs the full export pipeline to the specified directory.
    /// Returns the number of exported tables and any errors encountered.
    /// </summary>
    internal static (int TableCount, List<string> Errors) RunExport(
        Document doc, ExportSettings settings, string outputDir)
    {
        var enabled = new HashSet<string>(settings.EnabledTables);
        foreach (var (table, parent) in ImpliedBy)
            if (enabled.Contains(parent)) enabled.Add(table);

        var exporters = AllInstanceExporters().Where(e => enabled.Contains(e.TableName)).ToList();
        exporters.AddRange(TypeTableExporters.ForEnabled(enabled));
        if (settings.ExportMesh) exporters.Add(new MeshExporter());

        var idGen = new ShortIdGenerator();
        var errors = new List<string>();
        var meshFallback = new MeshFallbackSet();
        foreach (var exp in exporters)
        {
            if (exp is TableExporter te)
                te.MeshFallback = meshFallback;
        }

        ExportContext.Begin(doc);
        EnsureParameter(doc, errors);
        SeedIds(doc, idGen, errors);
        var exported = ExportTables(doc, exporters, errors);
        var tables = exported.Select(e => new ExportedTable(e.Exporter.TableName, e.Exporter.IsGlobal, e.Exporter.CsvColumns, e.Rows)).ToList();

        RunStep("Types", errors, () => ProjectWriter.ApplyTypes(tables));
        var levelIndex = ProjectWriter.AssignIds(tables, idGen);
        ProjectWriter.Finalize(tables, levelIndex);

        if (settings.ExportMesh)
        {
            ExportMeshFiles(outputDir, exported, idGen, errors);
            ExportFallbackMeshFiles(doc, outputDir, exported, idGen, meshFallback, errors);
        }
        // mesh.mesh_file is required: drop rows whose GLB could not be written.
        foreach (var t in tables.Where(t => t.TableName == "mesh"))
            t.Rows.RemoveAll(r => string.IsNullOrEmpty(r.GetValueOrDefault("mesh_file")));
        tables.RemoveAll(t => t.Rows.Count == 0);

        RunStep("CSV", errors, () => ProjectWriter.WriteCsvs(outputDir, tables, levelIndex));
        RunStep("IdMap", errors, () => ProjectWriter.WriteIdMap(outputDir, idGen));
        RunStep("GeoJSON export", errors, () => ProjectWriter.WriteGeometry(outputDir, tables, levelIndex));
        RunStep("Metadata", errors, () =>
            ProjectWriter.WriteMetadata(outputDir, doc.Title ?? "", $"Revit {doc.Application.VersionNumber}"));
        if (settings.WriteIdsToModel)
            WriteIdsToModel(doc, idGen, errors);

        return (tables.Count, errors);
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
                foreach (var element in collector.OrderBy(e => e.Id.Value))
                {
                    if (BimDownParameter.Get(element) is { } shortId)
                        idGen.Seed(element.UniqueId, shortId);
                }
            });
        }
    }

    static List<(ITableExporter Exporter, List<Dictionary<string, string?>> Rows)> ExportTables(
        Document doc, IEnumerable<ITableExporter> exporters, List<string> errors)
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

        // Short ids repeat across level directories: key rows by the element's UniqueId
        // (kept in "_uid" when the short id was assigned).
        var shortIdByUid = idGen.Mappings;
        var rowByElement = new Dictionary<ElementId, (Dictionary<string, string?> Row, string ShortId)>();
        foreach (var (exporter, rows) in exported)
        {
            if (exporter is MeshExporter) continue;
            foreach (var row in rows)
            {
                if (row.GetValueOrDefault("_uid") is not { } uid) continue;
                if (shortIdByUid.TryGetValue(uid, out var sid) && doc.GetElement(uid) is { } el)
                    rowByElement.TryAdd(el.Id, (row, sid));
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
                if (!rowByElement.TryGetValue(elementId, out var entry)) continue;
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
