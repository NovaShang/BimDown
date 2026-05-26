using Autodesk.Revit.DB;
using BimDown.RevitAddin.Extractors;

namespace BimDown.RevitAddin.Tables;

public class TableExporter(
    string tableName,
    BuiltInCategory[] categories,
    CompositeExtractor extractor,
    Func<Element, bool>? filter = null) : ITableExporter
{
    public string TableName => tableName;
    public IReadOnlyList<string> Columns => extractor.FieldNames;
    public IReadOnlyList<string> CsvColumns => extractor.CsvColumns;

    /// <summary>
    /// Optional mesh fallback set. When set, exporters can flag elements that
    /// cannot be precisely represented for GLB mesh export.
    /// </summary>
    public MeshFallbackSet? MeshFallback { get; set; }

    public List<Dictionary<string, string?>> Export(Document doc)
    {
        var rows = new List<Dictionary<string, string?>>();

        foreach (var category in categories)
        {
            var collector = new FilteredElementCollector(doc)
                .OfCategory(category)
                .WhereElementIsNotElementType();

            foreach (var element in collector.OrderBy(e => e.Id.Value))
            {
                try
                {
                    if (filter is not null && !filter(element)) continue;
                    var row = extractor.Extract(element);
                    DetectMeshFallback(element, row);
                    rows.Add(row);
                }
                catch
                {
                    // Skip elements that fail extraction
                }
            }
        }

        return rows;
    }

    void DetectMeshFallback(Element element, Dictionary<string, string?> row)
    {
        if (MeshFallback is null) return;

        if (element is Wall wall)
        {
            if (wall.WallType.Kind == WallKind.Curtain)
            {
                // Curtain wall: check base curve and profile geometry
                if (wall.Location is LocationCurve lc && lc.Curve is not (Line or Arc))
                    MeshFallback.Add(element.Id, "curved");
                else if (!HasRectangularProfile(wall))
                    MeshFallback.Add(element.Id, "edited_profile");
            }
            else
            {
                // Basic/stacked wall
                if (wall.SketchId != ElementId.InvalidElementId)
                    MeshFallback.Add(element.Id, "edited_profile");

                var slantAngle = wall.get_Parameter(BuiltInParameter.WALL_SINGLE_SLANT_ANGLE_FROM_VERTICAL)?.AsDouble() ?? 0;
                if (Math.Abs(slantAngle) > 0.001)
                    MeshFallback.Add(element.Id, "slanted");
            }
        }

        // Curved polygon edges (slab/roof/ceiling with arc segments)
        if (row.GetValueOrDefault("_has_curved_edges") == "true")
            MeshFallback.Add(element.Id, "curved_edges");

        // Point-located MEP elements: the schema only stores location + system + type,
        // so the actual 3D family must be carried as a GLB (deduped by TypeId in
        // ExportPipeline). mep_node / stair / ramp / railing intentionally stay
        // mesh-free — the consumer reconstructs them from topology / path + dims.
        if (tableName is "equipment" or "terminal")
            MeshFallback.Add(element.Id, "point_only");
    }

    /// <summary>
    /// Checks if a wall's sketch profile forms a rectangle (4 perpendicular lines).
    /// Walls without a sketch are assumed rectangular (default profile).
    /// </summary>
    static bool HasRectangularProfile(Wall wall)
    {
        if (wall.SketchId == ElementId.InvalidElementId) return true;
        if (wall.Document.GetElement(wall.SketchId) is not Sketch sketch) return true;

        var profile = sketch.Profile;
        if (profile.Size != 1) return false;

        var loop = profile.get_Item(0);
        if (loop.Size != 4) return false;

        var lines = new List<Line>(4);
        foreach (Curve curve in loop)
        {
            if (curve is not Line line) return false;
            lines.Add(line);
        }

        // All consecutive edges must be perpendicular
        for (var i = 0; i < 4; i++)
        {
            var dot = lines[i].Direction.DotProduct(lines[(i + 1) % 4].Direction);
            if (Math.Abs(dot) > 0.01) return false;
        }

        return true;
    }
}
