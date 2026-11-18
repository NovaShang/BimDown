using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using BimDown.RevitAddin.Extractors;
using BimDown.RevitAddin.Mapping;
using static BimDown.RevitAddin.RevitReaders;

namespace BimDown.RevitAddin.Tables;

/// <summary>
/// Revit stair by component → stair (its lowest run as its own line),
/// stair_run (the other runs) and stair_landing (landing footprints, top at
/// base_offset). Multistory stairs export their lowest stair with
/// multistory_top_level_id; the repetitions are generated from it.
/// </summary>
static class StairReader
{
    /// <summary>Absolute elevation (feet) of the stair's base: base level + base offset.</summary>
    static double BaseZ(Element stairs)
    {
        var doc = stairs.Document;
        var levelId = stairs.get_Parameter(BuiltInParameter.STAIRS_BASE_LEVEL_PARAM)?.AsElementId();
        var level = levelId is null ? null : doc.GetElement(levelId) as Level;
        return (level?.Elevation ?? 0) + (stairs.get_Parameter(BuiltInParameter.STAIRS_BASE_OFFSET)?.AsDouble() ?? 0);
    }

    static double LevelZ(Element stairs)
    {
        var levelId = stairs.get_Parameter(BuiltInParameter.STAIRS_BASE_LEVEL_PARAM)?.AsElementId();
        return levelId is null ? 0 : (stairs.Document.GetElement(levelId) as Level)?.Elevation ?? 0;
    }

    /// <summary>The stair's runs in meters, ordered bottom to top.</summary>
    internal static IReadOnlyList<StairRunInput> Runs(Stairs stairs)
    {
        var doc = stairs.Document;
        var baseZ = BaseZ(stairs);
        var list = new List<StairRunInput>();
        foreach (var id in stairs.GetStairsRuns())
        {
            if (doc.GetElement(id) is not StairsRun run) continue;
            try
            {
                var path = run.GetStairsPath();
                var curves = path.ToList();
                if (curves.Count == 0) continue;
                var a = curves[0].GetEndPoint(0);
                var b = curves[^1].GetEndPoint(1);
                list.Add(new StairRunInput(run.UniqueId,
                    M(a.X), M(a.Y), M(baseZ + run.BaseElevation),
                    M(b.X), M(b.Y), M(baseZ + run.TopElevation),
                    M(run.ActualRunWidth), run.ActualRisersNumber, run.StairsRunStyle.ToString()));
            }
            catch { /* skip unreadable runs */ }
        }
        return StairMapper.Order(list);
    }

    internal static Dictionary<string, string?> StairFields(Element e)
    {
        var f = new Dictionary<string, string?>();
        var doc = e.Document;
        if (e is Stairs stairs && Runs(stairs) is { Count: > 0 } runs)
        {
            var first = runs[0];
            Line(f, first);
            f["width"] = Names.Num(first.Width, 3);
            f["step_count"] = first.Risers.ToString();
            f["stair_type"] = StairMapper.Classify(runs);
            try
            {
                if (stairs.MultistoryStairsId is { } msId && msId != ElementId.InvalidElementId
                    && doc.GetElement(msId) is MultistoryStairs ms)
                {
                    var top = ms.GetAllConnectedLevels()
                        .Select(id => doc.GetElement(id) as Level)
                        .Where(l => l is not null)
                        .OrderByDescending(l => l!.Elevation)
                        .FirstOrDefault();
                    var topOfThis = stairs.get_Parameter(BuiltInParameter.STAIRS_TOP_LEVEL_PARAM)?.AsElementId();
                    if (top is not null && top.Id != topOfThis) f["multistory_top_level_id"] = top.UniqueId;
                }
            }
            catch { }
            return f;
        }

        // Legacy (sketched) stairs: an axis along the long side of the bounding box.
        var w = e.get_Parameter(BuiltInParameter.STAIRS_ATTR_TREAD_WIDTH).AsPositiveDouble();
        f["width"] = w is { } wv ? Names.Num(M(wv), 3) : null;
        f["step_count"] = e.get_Parameter(BuiltInParameter.STAIRS_ACTUAL_NUM_RISERS)?.AsInteger().ToString();
        if (e.get_BoundingBox(null) is { } bb)
        {
            var alongX = bb.Max.X - bb.Min.X >= bb.Max.Y - bb.Min.Y;
            var cx = (bb.Min.X + bb.Max.X) / 2;
            var cy = (bb.Min.Y + bb.Max.Y) / 2;
            var a = alongX ? new XYZ(bb.Min.X, cy, bb.Min.Z) : new XYZ(cx, bb.Min.Y, bb.Min.Z);
            var b = alongX ? new XYZ(bb.Max.X, cy, bb.Max.Z) : new XYZ(cx, bb.Max.Y, bb.Max.Z);
            Line(f, new StairRunInput(e.UniqueId, M(a.X), M(a.Y), M(a.Z), M(b.X), M(b.Y), M(b.Z), 0, 0));
        }
        f["stair_type"] = "straight";
        return f;
    }

    static void Line(Dictionary<string, string?> f, StairRunInput r)
    {
        f["start_x"] = Names.Num(r.X0); f["start_y"] = Names.Num(r.Y0); f["start_z"] = Names.Num(r.Z0);
        f["end_x"] = Names.Num(r.X1); f["end_y"] = Names.Num(r.Y1); f["end_z"] = Names.Num(r.Z1);
    }

    static IEnumerable<Stairs> ExportedStairs(Document doc) =>
        new FilteredElementCollector(doc).OfClass(typeof(Stairs)).Cast<Stairs>()
            .Where(ExportContext.IsStairExported)
            .OrderBy(s => s.Id.Value);

    /// <summary>Level references of the parent stair, so parts land in its directory.</summary>
    static void CopyLevels(Stairs stairs, Dictionary<string, string?> row)
    {
        var doc = stairs.Document;
        row["level_id"] = LevelUid(doc, stairs.get_Parameter(BuiltInParameter.STAIRS_BASE_LEVEL_PARAM)?.AsElementId());
        row["top_level_id"] = LevelUid(doc, stairs.get_Parameter(BuiltInParameter.STAIRS_TOP_LEVEL_PARAM)?.AsElementId());
    }

    internal sealed class RunExporter : ITableExporter
    {
        public string TableName => "stair_run";
        public IReadOnlyList<string> Columns { get; } = ["id", "number", "host_id", "width", "step_count", "material"];
        public IReadOnlyList<string> CsvColumns => Columns;

        public List<Dictionary<string, string?>> Export(Document doc)
        {
            var rows = new List<Dictionary<string, string?>>();
            foreach (var stairs in ExportedStairs(doc))
            {
                try
                {
                    var runs = Runs(stairs);
                    foreach (var r in runs.Skip(1))
                    {
                        var row = StairMapper.RunRow(r, stairs.UniqueId);
                        if (doc.GetElement(r.Id) is { } run)
                        {
                            row["material"] = new MaterializedExtractor().Extract(run)["material"];
                            row["number"] = run.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.AsString() is { Length: > 0 } m ? m : null;
                        }
                        CopyLevels(stairs, row);
                        rows.Add(row);
                    }
                }
                catch { }
            }
            return rows;
        }
    }

    internal sealed class LandingExporter : ITableExporter
    {
        public string TableName => "stair_landing";
        public IReadOnlyList<string> Columns { get; } = ["id", "number", "host_id", "base_offset", "thickness", "material"];
        public IReadOnlyList<string> CsvColumns => Columns;

        public List<Dictionary<string, string?>> Export(Document doc)
        {
            var rows = new List<Dictionary<string, string?>>();
            foreach (var stairs in ExportedStairs(doc))
            {
                var stairOffset = BaseZ(stairs) - LevelZ(stairs);
                foreach (var id in stairs.GetStairsLandings())
                {
                    if (doc.GetElement(id) is not StairsLanding landing) continue;
                    try
                    {
                        var pts = new List<XYZ>();
                        foreach (var c in landing.GetFootprintBoundary())
                            foreach (var p in c.Tessellate().Take(c.Tessellate().Count - 1))
                                pts.Add(p);
                        if (pts.Count < 3) continue;
                        var row = new Dictionary<string, string?>
                        {
                            ["id"] = landing.UniqueId,
                            ["host_id"] = stairs.UniqueId,
                            // BimDown landing base_offset is its top above the stair's level.
                            ["base_offset"] = Names.Num(M(stairOffset + landing.BaseElevation), 3),
                            ["thickness"] = landing.Thickness > 0 ? Names.Num(M(landing.Thickness), 3) : null,
                            ["material"] = new MaterializedExtractor().Extract(landing)["material"],
                            ["points"] = GeometryUtils.SerializePolygon(pts),
                        };
                        CopyLevels(stairs, row);
                        rows.Add(row);
                    }
                    catch { }
                }
            }
            return rows;
        }
    }
}
