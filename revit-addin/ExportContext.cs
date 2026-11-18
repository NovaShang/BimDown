using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using BimDown.RevitAddin.Mapping;

namespace BimDown.RevitAddin;

/// <summary>
/// Per-export caches shared by the table exporters (walls per level for the
/// "Pick Walls" boundary match, which stairs are exported). Reset by
/// <see cref="Begin"/> at the start of every export.
/// </summary>
static class ExportContext
{
    static Document? _doc;
    static Dictionary<ElementId, List<WallLine>>? _wallsByLevel;
    static Dictionary<ElementId, bool>? _stairExported;

    public static void Begin(Document doc)
    {
        _doc = doc;
        _wallsByLevel = null;
        _stairExported = null;
    }

    /// <summary>
    /// Walls, curtain walls and room separators a slab / roof / ceiling on
    /// <paramref name="levelId"/> can be bounded by (BimDown boundary_walls must be
    /// on the same level or in global/): walls based on that level and multi-storey
    /// walls passing through it.
    /// </summary>
    public static IReadOnlyList<WallLine> WallsNear(Document doc, ElementId levelId)
    {
        if (!ReferenceEquals(doc, _doc) || _wallsByLevel is null) BuildWalls(doc);
        return _wallsByLevel!.TryGetValue(levelId, out var list) ? list : [];
    }

    static void BuildWalls(Document doc)
    {
        _doc = doc;
        var map = _wallsByLevel = new Dictionary<ElementId, List<WallLine>>();
        var levels = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().OrderBy(l => l.Elevation).ToList();
        void Add(ElementId? level, WallLine line)
        {
            if (level is null || level == ElementId.InvalidElementId) return;
            if (!map.TryGetValue(level, out var list)) map[level] = list = [];
            list.Add(line);
        }
        foreach (var w in new FilteredElementCollector(doc).OfClass(typeof(Wall)).Cast<Wall>())
        {
            try
            {
                if (w.WallType.Kind == WallKind.Stacked) continue;
                if (RevitReaders.WallLineOf(w) is not { } line) continue;
                Add(w.LevelId, line);
                // A wall spanning more than one storey (exported to global/) bounds the levels it passes.
                var baseIdx = levels.FindIndex(l => l.Id == w.LevelId);
                var topIdx = levels.FindIndex(l => l.Id == w.get_Parameter(BuiltInParameter.WALL_HEIGHT_TYPE)?.AsElementId());
                if (baseIdx >= 0 && topIdx - baseIdx > 1)
                    for (var i = baseIdx + 1; i < topIdx; i++) Add(levels[i].Id, line);
            }
            catch { }
        }
        foreach (var e in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_RoomSeparationLines).WhereElementIsNotElementType())
        {
            if (e is not CurveElement { GeometryCurve: Line l } ce) continue;
            var a = l.GetEndPoint(0);
            var b = l.GetEndPoint(1);
            var levelId = ce.LevelId != ElementId.InvalidElementId ? ce.LevelId : (ce.SketchPlane?.GetPlane() is { } p ? NearestLevel(doc, p.Origin.Z) : null);
            Add(levelId, new WallLine(e.UniqueId, RevitReaders.M(a.X), RevitReaders.M(a.Y), RevitReaders.M(b.X), RevitReaders.M(b.Y), 0));
        }
    }

    static ElementId? NearestLevel(Document doc, double z) =>
        new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>()
            .OrderBy(l => Math.Abs(l.Elevation - z)).FirstOrDefault()?.Id;

    /// <summary>
    /// A stair is exported unless it is a repetition of a multistory stair: the
    /// lowest stair of the group is exported with multistory_top_level_id, the
    /// others are generated from it.
    /// </summary>
    public static bool IsStairExported(Stairs stairs)
    {
        _stairExported ??= new Dictionary<ElementId, bool>();
        if (_stairExported.TryGetValue(stairs.Id, out var known)) return known;
        var result = true;
        try
        {
            if (stairs.MultistoryStairsId is { } msId && msId != ElementId.InvalidElementId
                && stairs.Document.GetElement(msId) is MultistoryStairs ms)
            {
                var lowest = ms.GetAllStairsIds()
                    .Select(id => stairs.Document.GetElement(id) as Stairs)
                    .Where(s => s is not null)
                    .OrderBy(s => s!.BaseElevation)
                    .FirstOrDefault();
                result = lowest is null || lowest.Id == stairs.Id;
            }
        }
        catch { }
        _stairExported[stairs.Id] = result;
        return result;
    }
}
