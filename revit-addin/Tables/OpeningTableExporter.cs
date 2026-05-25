using Autodesk.Revit.DB;
using BimDown.RevitAddin.Extractors;
using static BimDown.RevitAddin.Extractors.ParameterUtils;

namespace BimDown.RevitAddin.Tables;

/// <summary>
/// Exports openings from two sources:
/// 1. Explicit Opening elements (wall rect openings, floor openings, shaft openings)
/// 2. Slab boundary inner loops (holes drawn in the floor sketch)
/// </summary>
public class OpeningTableExporter : ITableExporter
{
    static readonly string[] AllColumns =
    [
        "id", "number", "level_id", "created_at", "updated_at",
        "base_offset", "mesh_file", "volume",
        "bbox_min_x", "bbox_min_y", "bbox_min_z",
        "bbox_max_x", "bbox_max_y", "bbox_max_z",
        "host_id", "position", "width", "height", "shape", "points", "area",
    ];

    // level_id is computed; base_offset is a geojson_property — both kept out of CSV.
    // (base_offset stays in the row dict so slab-opening polygons can carry it in GeoJSON.)
    static readonly string[] CsvOnly =
    [
        "id", "number", "mesh_file",
        "host_id", "position", "width", "height", "shape",
    ];

    public string TableName => "opening";
    public IReadOnlyList<string> Columns => AllColumns;
    public IReadOnlyList<string> CsvColumns => CsvOnly;

    public List<Dictionary<string, string?>> Export(Document doc)
    {
        var rows = new List<Dictionary<string, string?>>();
        var elementExtractor = new ElementExtractor();

        // Source 1: Explicit Opening elements
        BuiltInCategory[] categories =
            [BuiltInCategory.OST_SWallRectOpening, BuiltInCategory.OST_FloorOpening, BuiltInCategory.OST_ShaftOpening];

        foreach (var category in categories)
        {
            var collector = new FilteredElementCollector(doc)
                .OfCategory(category)
                .WhereElementIsNotElementType();

            foreach (var element in collector.OrderBy(e => e.Id.Value))
            {
                try
                {
                    var row = elementExtractor.Extract(element);
                    ExtractOpeningFields(element, row);
                    // host_id is required (opening schema). Shaft/standalone openings
                    // with no host can't be represented as an opening — skip them.
                    if (string.IsNullOrEmpty(row.GetValueOrDefault("host_id"))) continue;
                    rows.Add(row);
                }
                catch { }
            }
        }

        // Source 2: Slab boundary inner loops
        var slabCollector = new FilteredElementCollector(doc)
            .OfCategory(BuiltInCategory.OST_Floors)
            .WhereElementIsNotElementType();

        foreach (var element in slabCollector.OrderBy(e => e.Id.Value))
        {
            try
            {
                var innerLoops = GetSlabInnerLoops(element);
                for (var i = 0; i < innerLoops.Count; i++)
                {
                    var row = elementExtractor.Extract(element);
                    // Synthetic ID to avoid collision with the host Floor's UniqueId
                    row["id"] = $"{element.UniqueId}:opening:{i}";
                    row["host_id"] = element.UniqueId;
                    row["points"] = GeometryUtils.SerializePolygon(innerLoops[i]);
                    rows.Add(row);
                }
            }
            catch { }
        }

        return rows;
    }

    static void ExtractOpeningFields(Element e, Dictionary<string, string?> fields)
    {
        Element? host = null;
        if (e is Opening opening)
            host = opening.Host;
        else if (e is FamilyInstance fi)
            host = fi.Host;

        if (host is not null)
            fields["host_id"] = host.UniqueId;

        // Wall opening mode
        if (host is Wall)
        {
            if (e is FamilyInstance fami && fami.Host is Wall hostWall
                && hostWall.Location is LocationCurve hostLc && fami.Location is LocationPoint lp)
            {
                var curve = hostLc.Curve;
                var result = curve.Project(lp.Point);
                if (result is not null)
                {
                    var normalizedParam = curve.ComputeNormalizedParameter(result.Parameter);
                    var distanceMeters = UnitConverter.Length(normalizedParam * curve.Length);
                    fields["position"] = UnitConverter.FormatDouble(distanceMeters);
                }
            }

            var w = e.get_Parameter(BuiltInParameter.FAMILY_WIDTH_PARAM)?.AsDouble()
                 ?? FindDoubleParameterByNames(e, "width", "w", "宽");
            var h = e.get_Parameter(BuiltInParameter.FAMILY_HEIGHT_PARAM)?.AsDouble()
                 ?? FindDoubleParameterByNames(e, "height", "h", "高");
            fields["width"] = w is { } wv ? UnitConverter.FormatDouble(UnitConverter.Length(wv)) : null;
            fields["height"] = h is { } hv ? UnitConverter.FormatDouble(UnitConverter.Length(hv)) : null;
            fields["shape"] = "rect";
        }
        // Slab/shaft opening — extract boundary as polygon loops
        else if (e is Opening slabOpening)
        {
            var boundary = slabOpening.BoundaryCurves;
            if (boundary is not null && boundary.Size > 0)
            {
                var loops = SplitCurvesIntoLoops(boundary);
                if (loops.Count > 0)
                    fields["points"] = GeometryUtils.SerializePolygon(loops[0]);
            }
        }
    }

    /// <summary>
    /// Splits a flat CurveArray into connected loops by detecting discontinuities.
    /// Each loop is returned as a list of vertex points.
    /// </summary>
    static List<List<XYZ>> SplitCurvesIntoLoops(CurveArray curves)
    {
        var loops = new List<List<XYZ>>();
        List<XYZ>? current = null;

        foreach (Curve curve in curves)
        {
            var start = curve.GetEndPoint(0);

            if (current is null || !current[^1].IsAlmostEqualTo(start))
            {
                // Start a new loop
                current = [start];
                loops.Add(current);
            }

            current.Add(curve.GetEndPoint(1));
        }

        // Remove closing duplicate point (last == first) from each loop
        foreach (var loop in loops)
        {
            if (loop.Count > 1 && loop[^1].IsAlmostEqualTo(loop[0]))
                loop.RemoveAt(loop.Count - 1);
        }

        return loops;
    }

    /// <summary>
    /// Extracts inner loops from a slab's top face geometry.
    /// Returns vertex lists for each inner loop (excluding the outer boundary).
    /// </summary>
    static List<List<XYZ>> GetSlabInnerLoops(Element element)
    {
        var result = new List<List<XYZ>>();
        var opt = new Options { ComputeReferences = false, DetailLevel = ViewDetailLevel.Coarse };
        var geom = element.get_Geometry(opt);
        if (geom is null) return result;

        // Find the top face (largest upward-facing planar face)
        PlanarFace? bestFace = null;
        double bestArea = 0;

        foreach (var obj in geom)
        {
            IEnumerable<GeometryObject>? solids = obj switch
            {
                Solid s => [s],
                GeometryInstance gi => gi.GetInstanceGeometry().OfType<Solid>(),
                _ => null,
            };
            if (solids is null) continue;

            foreach (var solid in solids.Cast<Solid>())
            {
                foreach (Face face in solid.Faces)
                {
                    if (face is PlanarFace planar && planar.FaceNormal.Z > 0.5 && planar.Area > bestArea)
                    {
                        bestArea = planar.Area;
                        bestFace = planar;
                    }
                }
            }
        }

        if (bestFace is null) return result;

        var loops = bestFace.GetEdgesAsCurveLoops();
        if (loops.Count <= 1) return result; // No inner loops

        // The outer loop is the one with the largest area; the rest are inner loops (openings)
        var ordered = loops.OrderByDescending(l => Math.Abs(l.GetExactLength())).ToList();

        foreach (var loop in ordered.Skip(1))
        {
            var pts = new List<XYZ>();
            foreach (var curve in loop)
                pts.Add(curve.GetEndPoint(0));
            result.Add(pts);
        }

        return result;
    }
}
