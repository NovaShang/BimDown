using Autodesk.Revit.DB;

namespace BimDown.RevitAddin.Tables;

class MeshExporter : ITableExporter
{
    static readonly BuiltInCategory[] MeshCategories =
    [
        BuiltInCategory.OST_GenericModel,
        BuiltInCategory.OST_Furniture,
        BuiltInCategory.OST_FurnitureSystems,
        BuiltInCategory.OST_Topography,
        BuiltInCategory.OST_Planting,
        BuiltInCategory.OST_Site,
    ];

    public string TableName => "mesh";
    public bool IsGlobal => true;

    public IReadOnlyList<string> Columns { get; } =
        ["id", "category", "name", "level_id", "mesh_file", "x", "y", "z", "rotation"];

    public IReadOnlyList<string> CsvColumns => Columns;

    // Store element references for GLB export after ID remapping
    readonly Dictionary<string, Element> _elementsByUid = new();

    public List<Dictionary<string, string?>> Export(Document doc)
    {
        var rows = new List<Dictionary<string, string?>>();

        foreach (var category in MeshCategories)
        {
            try
            {
                var collector = new FilteredElementCollector(doc)
                    .OfCategory(category)
                    .WhereElementIsNotElementType();

                foreach (var element in collector)
                {
                    try
                    {
                        var row = ExtractRow(element);
                        if (row is not null)
                        {
                            _elementsByUid[element.UniqueId] = element;
                            rows.Add(row);
                        }
                    }
                    catch
                    {
                        // Skip elements that fail extraction
                    }
                }
            }
            catch
            {
                // Skip categories that fail collection
            }
        }

        return rows;
    }

    /// <summary>
    /// Export GLB files for all mesh elements. Call after ID remapping so short IDs are used for filenames.
    /// Updates the mesh_file field in each row.
    /// </summary>
    internal List<string> ExportGlbFiles(string outputDir, List<Dictionary<string, string?>> rows,
        IReadOnlyDictionary<string, string> uidToShortId)
    {
        var errors = new List<string>();
        int ok = 0, noUid = 0, noElem = 0, noGeom = 0, fail = 0;

        // Group rows by TypeId to deduplicate identical meshes
        var typeToMeshPath = new Dictionary<ElementId, string?>();
        var rowsWithElements = new List<(Dictionary<string, string?> Row, Element Element, string ShortId)>();

        foreach (var row in rows)
        {
            var shortId = row.GetValueOrDefault("id");
            if (shortId is null) continue;

            var uid = uidToShortId.FirstOrDefault(kvp => kvp.Value == shortId).Key;
            if (uid is null) { noUid++; continue; }
            if (!_elementsByUid.TryGetValue(uid, out var element)) { noElem++; continue; }

            rowsWithElements.Add((row, element, shortId));
        }

        foreach (var (row, element, shortId) in rowsWithElements)
        {
            var typeId = element.GetTypeId();

            // If we already exported this type, reuse the path
            if (typeId != ElementId.InvalidElementId && typeToMeshPath.TryGetValue(typeId, out var cached))
            {
                row["mesh_file"] = cached ?? "";
                if (cached is not null) ok++;
                else noGeom++;
                continue;
            }

            try
            {
                var (origin, rotationRad) = GetPlacement(element);
                var meshPath = GlbExporter.ExportElement(element, outputDir, shortId, origin, rotationRad);
                row["mesh_file"] = meshPath ?? "";
                if (typeId != ElementId.InvalidElementId)
                    typeToMeshPath[typeId] = meshPath;
                if (meshPath is not null) ok++;
                else noGeom++;
            }
            catch (Exception ex)
            {
                row["mesh_file"] = "";
                if (typeId != ElementId.InvalidElementId)
                    typeToMeshPath[typeId] = null;
                fail++;
                if (fail <= 3)
                    errors.Add($"GLB {shortId}: {ex.Message}");
            }
        }

        // mesh_file is required — drop rows whose GLB could not be produced
        // (no geometry / export failure) so the table stays schema-valid.
        rows.RemoveAll(r => string.IsNullOrWhiteSpace(r.GetValueOrDefault("mesh_file")));

        if (fail > 0 || noUid > 0 || noElem > 0)
            errors.Insert(0, $"GLB: {ok} ok, {noGeom} no geometry, {noUid} no UID, {noElem} no element, {fail} failed (of {rows.Count})");
        return errors;
    }

    /// <summary>
    /// Gets the placement origin (Revit XYZ in feet) and rotation (radians) for an element.
    /// Used by both CSV row export and GLB local-coordinate transform.
    /// </summary>
    internal static (XYZ Origin, double RotationRad) GetPlacement(Element element)
    {
        if (element.Location is LocationPoint lp)
            return (lp.Point, lp.Rotation);

        if (element.Location is LocationCurve lc)
            return (lc.Curve.Evaluate(0.5, true), 0);

        var bb = element.get_BoundingBox(null);
        return bb is not null ? ((bb.Min + bb.Max) / 2, 0) : (XYZ.Zero, 0);
    }

    static Dictionary<string, string?>? ExtractRow(Element element)
    {
        var row = new Dictionary<string, string?>
        {
            ["id"] = element.UniqueId,
            ["category"] = element.Category?.Name,
            ["name"] = element.Name,
            ["mesh_file"] = "", // placeholder, filled in by ExportGlbFiles
        };

        // Level
        var levelId = element.LevelId;
        if (levelId != ElementId.InvalidElementId)
            row["level_id"] = element.Document.GetElement(levelId)?.UniqueId;

        // Position from Location or BoundingBox center
        var (origin, rotationRad) = GetPlacement(element);
        row["x"] = UnitConverter.FormatDouble(UnitConverter.Length(origin.X));
        row["y"] = UnitConverter.FormatDouble(UnitConverter.Length(origin.Y));
        row["z"] = UnitConverter.FormatDouble(UnitConverter.Length(origin.Z));
        row["rotation"] = UnitConverter.FormatDouble(rotationRad * 180 / Math.PI);

        return row;
    }
}
