using Autodesk.Revit.DB;
using BimDown.RevitAddin.Extractors;
using BimDown.RevitAddin.Mapping;
using static BimDown.RevitAddin.Extractors.ParameterUtils;
using static BimDown.RevitAddin.RevitReaders;

namespace BimDown.RevitAddin.Tables;

/// <summary>
/// Exports openings from three sources:
/// 1. Wall openings (rectangular Opening elements and opening families hosted on walls):
///    host_id + position + width / height, sill in CSV base_offset.
/// 2. Floor / roof openings and shafts: a Polygon; shafts carry top_level_id /
///    top_offset and cut every slab, ceiling and roof they pass through.
/// 3. Slab boundary inner loops (holes drawn in the floor sketch).
/// </summary>
public class OpeningTableExporter : ITableExporter
{
    static readonly string[] AllColumns =
    [
        "id", "number", "level_id", "created_at", "updated_at",
        "base_offset", "mesh_file", "volume", "group_id", "pinned",
        "bbox_min_x", "bbox_min_y", "bbox_min_z",
        "bbox_max_x", "bbox_max_y", "bbox_max_z",
        "host_id", "position", "width", "height", "shape", "top_level_id", "top_offset", "points", "area",
    ];

    // Opening base_offset / top_offset are CSV fields (schema storage: csv), unlike other elements.
    static readonly string[] CsvOnly =
    [
        "id", "number", "mesh_file", "group_id", "pinned",
        "host_id", "position", "width", "height", "shape", "base_offset", "top_level_id", "top_offset",
    ];

    public string TableName => "opening";
    public IReadOnlyList<string> Columns => AllColumns;
    public IReadOnlyList<string> CsvColumns => CsvOnly;

    public List<Dictionary<string, string?>> Export(Document doc)
    {
        var rows = new List<Dictionary<string, string?>>();
        var elementExtractor = new ElementExtractor();

        // Source 1 + 2: explicit Opening elements
        BuiltInCategory[] categories =
            [BuiltInCategory.OST_SWallRectOpening, BuiltInCategory.OST_FloorOpening, BuiltInCategory.OST_RoofOpening, BuiltInCategory.OST_ShaftOpening];

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
                    row["base_offset"] = null;
                    var isShaft = category == BuiltInCategory.OST_ShaftOpening;
                    if (isShaft) ExtractShaftFields(element, row);
                    else ExtractOpeningFields(element, row);
                    // host_id is required except for shafts.
                    if (!isShaft && string.IsNullOrEmpty(row.GetValueOrDefault("host_id"))) continue;
                    if (isShaft && row.GetValueOrDefault("points") is null) continue;
                    rows.Add(row);
                }
                catch { }
            }
        }

        var cutters = rows
            .Select(r => r.GetValueOrDefault("points"))
            .Where(p => p is not null)
            .Select(p => System.Text.Json.JsonSerializer.Deserialize<double[][]>(p!)!)
            .Where(p => p is { Length: >= 3 })
            .ToList();

        // Source 3: Slab boundary inner loops
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
                    // Holes cut by an exported floor opening / shaft are that opening, not a sketch hole.
                    var cx = innerLoops[i].Average(p => M(p.X));
                    var cy = innerLoops[i].Average(p => M(p.Y));
                    if (cutters.Any(poly => Inside(poly, cx, cy))) continue;
                    var row = elementExtractor.Extract(element);
                    // Synthetic ID to avoid collision with the host Floor's UniqueId
                    row["id"] = $"{element.UniqueId}:opening:{i}";
                    row["number"] = null;
                    row["base_offset"] = null;
                    row["host_id"] = element.UniqueId;
                    row["points"] = GeometryUtils.SerializePolygon(innerLoops[i]);
                    rows.Add(row);
                }
            }
            catch { }
        }

        return rows;
    }

    static bool Inside(double[][] poly, double x, double y)
    {
        var inside = false;
        for (int i = 0, j = poly.Length - 1; i < poly.Length; j = i++)
        {
            var (xi, yi, xj, yj) = (poly[i][0], poly[i][1], poly[j][0], poly[j][1]);
            if ((yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
    }

    static void ExtractShaftFields(Element e, Dictionary<string, string?> row)
    {
        var doc = e.Document;
        var baseLevel = e.get_Parameter(BuiltInParameter.WALL_BASE_CONSTRAINT)?.AsElementId();
        var topLevel = e.get_Parameter(BuiltInParameter.WALL_HEIGHT_TYPE)?.AsElementId();
        if (LevelUid(doc, baseLevel) is { } b) row["level_id"] = b;
        row["top_level_id"] = LevelUid(doc, topLevel);
        var bo = e.get_Parameter(BuiltInParameter.WALL_BASE_OFFSET)?.AsDouble() ?? 0;
        var to = e.get_Parameter(BuiltInParameter.WALL_TOP_OFFSET)?.AsDouble() ?? 0;
        row["base_offset"] = Math.Abs(bo) > 1e-9 ? Names.Num(M(bo), 3) : null;
        row["top_offset"] = Math.Abs(to) > 1e-9 ? Names.Num(M(to), 3) : null;
        // A shaft stays on its base level although it spans storeys.
        row["_keep_level"] = "true";
        if (e is Opening o && o.BoundaryCurves is { Size: > 0 } curves && SplitCurvesIntoLoops(curves) is { Count: > 0 } loops)
            row["points"] = GeometryUtils.SerializePolygon(loops[0]);
    }

    static void ExtractOpeningFields(Element e, Dictionary<string, string?> fields)
    {
        Element? host = e switch { Opening opening => opening.Host, FamilyInstance fi => fi.Host, _ => null };
        if (host is not null)
            fields["host_id"] = host.UniqueId;

        if (host is Wall wall && wall.Location is LocationCurve hostLc)
        {
            var curve = hostLc.Curve;
            var levelZ = (e.Document.GetElement(wall.LevelId) as Level)?.Elevation ?? 0;
            XYZ? center = null;
            if (e is Opening { IsRectBoundary: true } rect && rect.BoundaryRect is { Count: 2 } br)
            {
                var a = br[0];
                var b = br[1];
                center = (a + b) / 2;
                fields["width"] = Names.Num(M(Math.Sqrt(Math.Pow(b.X - a.X, 2) + Math.Pow(b.Y - a.Y, 2))), 3);
                fields["height"] = Names.Num(M(Math.Abs(b.Z - a.Z)), 3);
                fields["base_offset"] = Names.Num(M(Math.Min(a.Z, b.Z) - levelZ), 3);
            }
            else
            {
                if (e.Location is LocationPoint lp) center = lp.Point;
                var w = e.get_Parameter(BuiltInParameter.FAMILY_WIDTH_PARAM).AsPositiveDouble()
                     ?? FindDoubleParameterByNames(e, "width", "w", "宽");
                var h = e.get_Parameter(BuiltInParameter.FAMILY_HEIGHT_PARAM).AsPositiveDouble()
                     ?? FindDoubleParameterByNames(e, "height", "h", "高");
                fields["width"] = w is { } wv ? Names.Num(M(wv), 3) : null;
                fields["height"] = h is { } hv ? Names.Num(M(hv), 3) : null;
                var sill = e.get_Parameter(BuiltInParameter.INSTANCE_SILL_HEIGHT_PARAM)?.AsDouble();
                fields["base_offset"] = sill is { } s ? Names.Num(M(s), 3) : null;
            }
            if (center is not null && curve.Project(center) is { } result)
            {
                var normalizedParam = curve.ComputeNormalizedParameter(result.Parameter);
                fields["position"] = Names.Num(M(normalizedParam * curve.Length));
            }
            fields["shape"] = Names.ContainsAny((e as FamilyInstance)?.Symbol?.FamilyName, "round", "circular", "圆") ? "round"
                : Names.ContainsAny((e as FamilyInstance)?.Symbol?.FamilyName, "arch", "拱") ? "arch" : "rect";
            if (fields.GetValueOrDefault("base_offset") is "0") fields["base_offset"] = null;
            if (IsReversed(wall)) WallMapper.ReverseHosted(fields, M(curve.Length));
        }
        // Slab / roof opening — extract boundary as polygon loops
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
