using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.DB.Structure;
using BimDown.RevitAddin.Mapping;
using BimDown.RevitAddin.Tables;

namespace BimDown.RevitAddin.Import;

static class ImportGeometry
{
    public static double Ft(string? meters) => UnitConverter.LengthToFeet(UnitConverter.ParseNullableDouble(meters) ?? 0);

    public static double? FtOrNull(string? meters) =>
        UnitConverter.ParseNullableDouble(meters) is { } m ? UnitConverter.LengthToFeet(m) : null;

    /// <summary>"_path" ([[x,y,z],…] meters) or start / end of a line row, in feet.</summary>
    public static List<XYZ> Path(Dictionary<string, string?> row, double z)
    {
        var pts = new List<XYZ>();
        if (row.GetValueOrDefault("_path") is { } json)
        {
            try
            {
                foreach (var p in JsonSerializer.Deserialize<double[][]>(json) ?? [])
                    pts.Add(new XYZ(UnitConverter.LengthToFeet(p[0]), UnitConverter.LengthToFeet(p[1]), z));
            }
            catch { pts.Clear(); }
        }
        if (pts.Count < 2 && row.GetValueOrDefault("start_x") is not null)
        {
            pts.Clear();
            pts.Add(new XYZ(Ft(row["start_x"]), Ft(row.GetValueOrDefault("start_y")), z));
            pts.Add(new XYZ(Ft(row.GetValueOrDefault("end_x")), Ft(row.GetValueOrDefault("end_y")), z));
        }
        return pts;
    }
}

/// <summary>
/// Stairs by component: the stair's own line and its stair_run rows become
/// straight runs (in start-Z order) inside a StairsEditScope, consecutive runs
/// get automatic landings, and multistory_top_level_id connects the levels of a
/// multistory stair. Edit scopes cannot run inside a transaction, so this
/// importer manages its own.
/// </summary>
class StairImporter() : TableImporterBase("stair", 16, [BuiltInCategory.OST_Stairs])
{
    public override bool OwnsTransactions => true;

    sealed class Preprocessor : IFailuresPreprocessor
    {
        public FailureProcessingResult PreprocessFailures(FailuresAccessor a)
        {
            foreach (var f in a.GetFailureMessages())
                if (f.GetSeverity() == FailureSeverity.Warning) a.DeleteWarning(f);
            return FailureProcessingResult.Continue;
        }
    }

    public override ImportResult Import(Document doc, List<Dictionary<string, string?>> csvRows, IReadOnlyDictionary<string, string>? uuidToIdMap = null)
    {
        // Deletes and updates in one transaction (the base does the diff), creates each in an edit scope.
        var toCreate = new List<Dictionary<string, string?>>();
        _deferred = toCreate;
        ImportResult first;
        using (var tx = new Transaction(doc, "BimDown Import: stair"))
        {
            tx.Start();
            first = base.Import(doc, csvRows, uuidToIdMap);
            tx.Commit();
        }
        _deferred = null;
        var errors = new List<string>(first.Errors);
        var created = 0;
        foreach (var row in toCreate)
        {
            IdMap.CurrentDir = row.GetValueOrDefault("_dir") ?? "global";
            try
            {
                if (CreateStair(doc, row) is { } stairs)
                {
                    using var tx = new Transaction(doc, "BimDown: stair id");
                    tx.Start();
                    Track(row, stairs);
                    tx.Commit();
                    created++;
                }
            }
            catch (Exception ex) { errors.Add($"Create {row.GetValueOrDefault("id")}: {ex.Message}"); }
        }
        return new ImportResult(first.Created + created, first.Updated, first.Deleted, errors);
    }

    List<Dictionary<string, string?>>? _deferred;

    protected override Element? CreateElement(Document doc, Dictionary<string, string?> row)
    {
        _deferred?.Add(row);
        return null;
    }

    Element? CreateStair(Document doc, Dictionary<string, string?> row)
    {
        var id = row.GetValueOrDefault("id");
        var dir = row.GetValueOrDefault("_dir");
        var baseLevel = IdMap.ResolveLevel(doc, row.GetValueOrDefault("base_level_id") ?? row.GetValueOrDefault("level_id"))
            ?? throw new InvalidOperationException("base level does not resolve");
        // Geometry Z (absolute, m): bottom of the first run, top of the last one.
        var runZ = new[] { row }.Concat(ImportContext.Rows.GetValueOrDefault("stair_run")?
                .Where(r => r.GetValueOrDefault("host_id") == id && r.GetValueOrDefault("_dir") == dir) ?? [])
            .Select(r => (Z0: UnitConverter.ParseNullableDouble(r.GetValueOrDefault("start_z")), Z1: UnitConverter.ParseNullableDouble(r.GetValueOrDefault("end_z"))))
            .ToList();
        var bottomZ = runZ.Where(z => z.Z0 is not null).Select(z => z.Z0!.Value).DefaultIfEmpty(double.NaN).Min();
        var topZ = runZ.Where(z => z.Z1 is not null).Select(z => z.Z1!.Value).DefaultIfEmpty(double.NaN).Max();
        var levelsAbove = LevelsAbove(doc, baseLevel);
        var topLevel = IdMap.ResolveLevel(doc, row.GetValueOrDefault("top_level_id"))
            // No top level given: the first level at or above the stair's top (else the next one).
            ?? (double.IsNaN(topZ) ? null : levelsAbove.FirstOrDefault(l => l.Elevation >= UnitConverter.LengthToFeet(topZ) - 1e-3))
            ?? levelsAbove.FirstOrDefault()
            ?? throw new InvalidOperationException("no level above the stair's base");
        // A top level at or below the base (exported from a stair whose base is offset up to
        // its top level): Revit needs a higher one; the top offset then comes from the Z.
        var topFromZ = row.GetValueOrDefault("top_level_id") is null;
        if (topLevel.Elevation <= baseLevel.Elevation + 1e-6)
        {
            topLevel = (double.IsNaN(topZ) ? null : levelsAbove.FirstOrDefault(l => l.Elevation >= UnitConverter.LengthToFeet(topZ) - 1e-3))
                       ?? levelsAbove.FirstOrDefault()
                       ?? throw new InvalidOperationException("no level above the stair's base");
            topFromZ = true;
        }

        // Runs: the stair's own line (when it is not an overall axis) + its stair_run rows.
        var runs = new List<(Dictionary<string, string?> Row, double Z0, int Risers, double Width)>();
        var runRows = ImportContext.Rows.GetValueOrDefault("stair_run")?
            .Where(r => r.GetValueOrDefault("host_id") == id && r.GetValueOrDefault("_dir") == dir).ToList() ?? [];
        if (row.GetValueOrDefault("start_x") is not null)
            runs.Add((row, UnitConverter.ParseNullableDouble(row.GetValueOrDefault("start_z")) ?? 0,
                int.TryParse(row.GetValueOrDefault("step_count"), out var s0) ? s0 : 0,
                UnitConverter.ParseNullableDouble(row.GetValueOrDefault("width")) ?? 1.2));
        foreach (var r in runRows)
            runs.Add((r, UnitConverter.ParseNullableDouble(r.GetValueOrDefault("start_z")) ?? 0,
                int.TryParse(r.GetValueOrDefault("step_count"), out var s) ? s : 0,
                UnitConverter.ParseNullableDouble(r.GetValueOrDefault("width")) ?? 1.2));
        runs = runs.OrderBy(r => r.Z0).ToList();
        if (runRows.Count > 0 && runs.Count > 1 && row.GetValueOrDefault("start_x") is not null)
        {
            // An overall axis (same bottom and top as the runs together) is not a run.
            var own = runs.First(r => ReferenceEquals(r.Row, row));
            var ownTop = UnitConverter.ParseNullableDouble(row.GetValueOrDefault("end_z")) ?? 0;
            var top = runRows.Max(r => UnitConverter.ParseNullableDouble(r.GetValueOrDefault("end_z")) ?? 0);
            if (Math.Abs(own.Z0 - runs.Where(r => !ReferenceEquals(r.Row, row)).Min(r => r.Z0)) < 1e-3 && Math.Abs(ownTop - top) < 1e-3)
                runs.RemoveAll(r => ReferenceEquals(r.Row, row));
        }
        if (runs.Count == 0) throw new InvalidOperationException("stair has no run geometry");

        ElementId stairsId;
        var runIds = new List<ElementId>();
        var landingIds = new List<ElementId>();
        using (var scope = new StairsEditScope(doc, "BimDown stair"))
        {
            stairsId = scope.Start(baseLevel.Id, topLevel.Id);
            using (var tx = new Transaction(doc, "BimDown: stair runs"))
            {
                tx.Start();
                // A stair that starts above its level or stops below / above its top level
                // (e.g. one flight of a two-flight stair written as two stairs).
                if (doc.GetElement(stairsId) is Stairs span)
                {
                    if (!double.IsNaN(bottomZ) && UnitConverter.LengthToFeet(bottomZ) - baseLevel.Elevation is var baseOffset && Math.Abs(baseOffset) > 1e-4)
                        span.get_Parameter(BuiltInParameter.STAIRS_BASE_OFFSET)?.Set(baseOffset);
                    var topOffset = UnitConverter.ParseNullableDouble(row.GetValueOrDefault("top_offset")) is { } to
                        ? UnitConverter.LengthToFeet(to)
                        : !double.IsNaN(topZ) && topFromZ ? UnitConverter.LengthToFeet(topZ) - topLevel.Elevation : 0;
                    if (Math.Abs(topOffset) > 1e-4)
                        span.get_Parameter(BuiltInParameter.STAIRS_TOP_OFFSET)?.Set(topOffset);
                }
                if (doc.GetElement(stairsId) is Stairs st && runs.Sum(r => r.Risers) is var total and > 0)
                    st.DesiredRisersNumber = total;
                var stairBase = baseLevel.Elevation + (double.IsNaN(bottomZ) ? 0 : UnitConverter.LengthToFeet(bottomZ) - baseLevel.Elevation);
                foreach (var r in runs)
                {
                    // A run's path sits at its own bottom (its line's start Z), not at the level.
                    var z = UnitConverter.ParseNullableDouble(r.Row.GetValueOrDefault("start_z")) is { } z0 ? UnitConverter.LengthToFeet(z0) : stairBase;
                    var line = Line.CreateBound(
                        new XYZ(ImportGeometry.Ft(r.Row["start_x"]), ImportGeometry.Ft(r.Row.GetValueOrDefault("start_y")), z),
                        new XYZ(ImportGeometry.Ft(r.Row.GetValueOrDefault("end_x")), ImportGeometry.Ft(r.Row.GetValueOrDefault("end_y")), z));
                    var run = StairsRun.CreateStraightRun(doc, stairsId, line, StairsRunJustification.Center);
                    run.ActualRunWidth = UnitConverter.LengthToFeet(r.Width);
                    runIds.Add(run.Id);
                }
                for (var i = 1; i < runIds.Count; i++)
                {
                    try
                    {
                        if (StairsLanding.CanCreateAutomaticLanding(doc, runIds[i - 1], runIds[i]))
                            landingIds.AddRange(StairsLanding.CreateAutomaticLanding(doc, runIds[i - 1], runIds[i]));
                    }
                    catch { /* runs that do not meet: no landing */ }
                }
                tx.Commit();
            }
            scope.Commit(new Preprocessor());
        }

        using (var tx = new Transaction(doc, "BimDown: stair parts"))
        {
            tx.Start();
            // BimDown ids on the created runs (stair_run rows) and landings (stair_landing rows, in order).
            var runRowsInOrder = runs.Select(r => r.Row).ToList();
            for (var i = 0; i < runIds.Count && i < runRowsInOrder.Count; i++)
                if (!ReferenceEquals(runRowsInOrder[i], row) && doc.GetElement(runIds[i]) is { } runEl) Track(runRowsInOrder[i], runEl);
            var landingRows = ImportContext.Rows.GetValueOrDefault("stair_landing")?
                .Where(r => r.GetValueOrDefault("host_id") == id && r.GetValueOrDefault("_dir") == dir).ToList() ?? [];
            for (var i = 0; i < landingIds.Count && i < landingRows.Count; i++)
                if (doc.GetElement(landingIds[i]) is { } le) Track(landingRows[i], le);

            if (doc.GetElement(stairsId) is Stairs stairs && IdMap.ResolveLevel(doc, row.GetValueOrDefault("multistory_top_level_id")) is { } msTop)
            {
                var ms = MultistoryStairs.Create(stairs);
                var levels = LevelsAbove(doc, topLevel)
                    .Where(l => l.Elevation <= msTop.Elevation + 1e-6)
                    .Select(l => l.Id).ToHashSet();
                if (levels.Count > 0) ms.ConnectLevels(levels);
            }
            if (doc.GetElement(stairsId) is { } created) SetMark(created, row);
            tx.Commit();
        }
        return doc.GetElement(stairsId);
    }

    protected override void UpdateElement(Document doc, Dictionary<string, string?> row, Element element)
    {
        var topLevelId = IdMap.Resolve(doc, row.GetValueOrDefault("top_level_id"));
        if (topLevelId is not null)
            element.get_Parameter(BuiltInParameter.STAIRS_TOP_LEVEL_PARAM)?.Set(topLevelId);
        SetMark(element, row);
    }
}

/// <summary>
/// Railings: on a stair (host_id + side) → Revit creates both sides on the
/// treads, each row takes the one on its side; sketched / slab railings → a
/// railing along the path on the level. railing_type by name.
/// </summary>
class RailingImporter() : TableImporterBase("railing", 17, [BuiltInCategory.OST_StairsRailing])
{
    static ElementId RailingTypeId(Document doc, string? typeId)
    {
        var name = ImportContext.Type(typeId)?.GetValueOrDefault("name");
        var types = new FilteredElementCollector(doc).OfClass(typeof(RailingType)).Cast<RailingType>().ToList();
        return (types.FirstOrDefault(t => t.Name == name) ?? types.FirstOrDefault())?.Id
               ?? throw new InvalidOperationException("No RailingType in the model");
    }

    protected override Element? CreateElement(Document doc, Dictionary<string, string?> row)
    {
        var typeId = RailingTypeId(doc, row.GetValueOrDefault("type_id"));
        var host = IdMap.Resolve(doc, row.GetValueOrDefault("host_id")) is { } hid ? doc.GetElement(hid) : null;
        if (host is Stairs stairs)
        {
            if (!ImportContext.StairRailings.TryGetValue(stairs.Id, out var made))
            {
                made = [];
                var runs = StairReader.Runs(stairs);
                // A stair type with a default railing already made them with the stair:
                // reuse those (Railing.Create refuses a stair that has railings).
                var existing = stairs.GetAssociatedRailings();
                foreach (var rid in existing.Count > 0 ? existing : Railing.Create(doc, stairs.Id, typeId, RailingPlacementPosition.Treads))
                {
                    if (doc.GetElement(rid) is not Railing r) continue;
                    if (r.GetTypeId() != typeId) r.ChangeTypeId(typeId);
                    var pts = r.GetPath().SelectMany(c => c.Tessellate()).ToList();
                    var mid = pts.Count > 0 ? pts[pts.Count / 2] : XYZ.Zero;
                    var side = runs.Count > 0 ? StairMapper.RailingSide(runs[0], UnitConverter.Length(mid.X), UnitConverter.Length(mid.Y)) : "left";
                    made.Add((rid, side));
                }
                ImportContext.StairRailings[stairs.Id] = made;
            }
            var want = row.GetValueOrDefault("side") ?? "left";
            var pick = made.FirstOrDefault(m => m.Side == want);
            if (pick.Railing is null) return null;
            made.Remove(pick);
            var railing = doc.GetElement(pick.Railing);
            SetMark(railing, row);
            return railing;
        }

        var level = IdMap.ResolveLevel(doc, row.GetValueOrDefault("level_id"))
            ?? throw new InvalidOperationException("level_id is required");
        var pts2 = ImportGeometry.Path(row, level.Elevation);
        if (pts2.Count < 2) throw new InvalidOperationException("railing has no path");
        var loop = new CurveLoop();
        for (var i = 1; i < pts2.Count; i++)
            if (pts2[i].DistanceTo(pts2[i - 1]) > 1e-4) loop.Append(Line.CreateBound(pts2[i - 1], pts2[i]));
        var sketched = Railing.Create(doc, loop, typeId, level.Id);
        SetMark(sketched, row);
        return sketched;
    }

    protected override void UpdateElement(Document doc, Dictionary<string, string?> row, Element element)
    {
        if (element is Railing r && row.GetValueOrDefault("type_id") is { } t && RailingTypeId(doc, t) is var tid && r.GetTypeId() != tid)
            r.ChangeTypeId(tid);
        SetMark(element, row);
    }
}

/// <summary>
/// Furniture rows → the family type named by furniture_type, else the first
/// family whose names guess the same library family, else a DirectShape box of
/// the row's size (Generic Models, tagged as BimDown furniture).
/// </summary>
class FurnitureImporter() : TableImporterBase("furniture", 30,
    [.. TypeTableExporters.FurnitureCategories, BuiltInCategory.OST_GenericModel],
    e => e is FamilyInstance fi ? fi.Category?.BuiltInCategory != BuiltInCategory.OST_GenericModel
        : e is DirectShape ds && ds.ApplicationDataId == FurnitureImporter.DataId)
{
    internal const string DataId = "BimDown.furniture";

    protected override Element? CreateElement(Document doc, Dictionary<string, string?> row)
    {
        var level = IdMap.ResolveLevel(doc, row.GetValueOrDefault("level_id"))
            ?? throw new InvalidOperationException("level_id is required");
        var x = ImportGeometry.Ft(row.GetValueOrDefault("x"));
        var y = ImportGeometry.Ft(row.GetValueOrDefault("y"));
        var z = level.Elevation + ImportGeometry.Ft(row.GetValueOrDefault("base_offset"));
        var rot = UnitConverter.AngleToRadians(UnitConverter.ParseNullableDouble(row.GetValueOrDefault("rotation")) ?? 0);
        var family = row.GetValueOrDefault("family") ?? "generic_box";

        var symbol = TypeResolver.ResolveNamedSymbol(doc, row.GetValueOrDefault("type_id"), TypeTableExporters.FurnitureCategories)
                     ?? GuessSymbol(doc, family);
        if (symbol is not null)
        {
            // BimDown points sit at the footprint centre; Revit families at their insertion point.
            var (cx, cy) = symbol.get_BoundingBox(null) is { } bb
                ? FurnitureMapper.FootprintCenter(0, 0, rot, bb.Min.X, bb.Max.X, bb.Min.Y, bb.Max.Y)
                : (0, 0);
            var pt = new XYZ(x - cx, y - cy, z);
            var fi = doc.Create.NewFamilyInstance(pt, symbol, level, StructuralType.NonStructural);
            if (Math.Abs(rot) > 1e-9)
                ElementTransformUtils.RotateElement(doc, fi.Id, Line.CreateBound(pt, pt + XYZ.BasisZ), rot);
            SetMark(fi, row);
            return fi;
        }

        // Placeholder box of the row's size.
        var sx = ImportGeometry.FtOrNull(row.GetValueOrDefault("size_x")) ?? 3.28;
        var sy = ImportGeometry.FtOrNull(row.GetValueOrDefault("size_y")) ?? 3.28;
        var h = ImportGeometry.FtOrNull(row.GetValueOrDefault("height")) ?? 3.28;
        // Flat 2D families (clearance circles) report 0: a sliver, not a failure.
        (sx, sy, h) = (Math.Max(sx, 0.01), Math.Max(sy, 0.01), Math.Max(h, 0.01));
        var c = Math.Cos(rot);
        var s = Math.Sin(rot);
        XYZ P(double lx, double ly) => new(x + lx * c - ly * s, y + lx * s + ly * c, z);
        var loop = CurveLoop.Create(
        [
            Line.CreateBound(P(-sx / 2, -sy / 2), P(sx / 2, -sy / 2)), Line.CreateBound(P(sx / 2, -sy / 2), P(sx / 2, sy / 2)),
            Line.CreateBound(P(sx / 2, sy / 2), P(-sx / 2, sy / 2)), Line.CreateBound(P(-sx / 2, sy / 2), P(-sx / 2, -sy / 2)),
        ]);
        var solid = GeometryCreationUtilities.CreateExtrusionGeometry([loop], XYZ.BasisZ, h);
        var ds = DirectShape.CreateElement(doc, new ElementId(BuiltInCategory.OST_GenericModel));
        ds.ApplicationId = "BimDown";
        ds.ApplicationDataId = DataId;
        ds.SetShape([solid]);
        ds.Name = family;
        SetMark(ds, row);
        return ds;
    }

    static FamilySymbol? GuessSymbol(Document doc, string family)
    {
        if (family is "generic_box" or "generic_cylinder") return null;
        foreach (var cat in TypeTableExporters.FurnitureCategories)
        {
            var symbol = new FilteredElementCollector(doc).OfCategory(cat).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>()
                .FirstOrDefault(fs => FurnitureMapper.Guess(fs.FamilyName, fs.Name, fs.Category?.Name).Family == family);
            if (symbol is null) continue;
            if (!symbol.IsActive) symbol.Activate();
            return symbol;
        }
        return null;
    }

    protected override void UpdateElement(Document doc, Dictionary<string, string?> row, Element element)
    {
        if (element is FamilyInstance { Location: LocationPoint lp } fi)
        {
            var rot = UnitConverter.AngleToRadians(UnitConverter.ParseNullableDouble(row.GetValueOrDefault("rotation")) ?? 0);
            var (cx, cy) = fi.Symbol.get_BoundingBox(null) is { } bb
                ? FurnitureMapper.FootprintCenter(0, 0, rot, bb.Min.X, bb.Max.X, bb.Min.Y, bb.Max.Y, fi.Mirrored)
                : (0, 0);
            var target = new XYZ(ImportGeometry.Ft(row.GetValueOrDefault("x")) - cx, ImportGeometry.Ft(row.GetValueOrDefault("y")) - cy, lp.Point.Z);
            var delta = target - lp.Point;
            if (delta.GetLength() > 1e-9) ElementTransformUtils.MoveElement(doc, fi.Id, delta);
            var turn = rot - lp.Rotation;
            if (Math.Abs(turn) > 1e-9)
                ElementTransformUtils.RotateElement(doc, fi.Id, Line.CreateBound(target, target + XYZ.BasisZ), turn);
        }
        SetMark(element, row);
    }
}

/// <summary>
/// Beam systems: the bay, beam direction, maximum spacing and beam type. Their
/// beams (beam_system_id) are generated by Revit, so BeamImporter skips them.
/// </summary>
class BeamSystemImporter() : TableImporterBase("beam_system", 16, [BuiltInCategory.OST_StructuralFramingSystem])
{
    protected override Element? CreateElement(Document doc, Dictionary<string, string?> row)
    {
        var level = IdMap.ResolveLevel(doc, row.GetValueOrDefault("level_id"))
            ?? throw new InvalidOperationException("level_id is required");
        var pts = GeometryUtils.DeserializePolygon(row.GetValueOrDefault("points") ?? throw new InvalidOperationException("points is required"));
        var curves = new List<Curve>();
        for (var i = 0; i < pts.Count; i++)
            curves.Add(Line.CreateBound(new XYZ(pts[i].X, pts[i].Y, level.Elevation),
                new XYZ(pts[(i + 1) % pts.Count].X, pts[(i + 1) % pts.Count].Y, level.Elevation)));
        var deg = UnitConverter.ParseNullableDouble(row.GetValueOrDefault("direction")) ?? 0;
        var dir = new XYZ(Math.Cos(deg * Math.PI / 180), Math.Sin(deg * Math.PI / 180), 0);
        var bs = BeamSystem.Create(doc, curves, level, dir, false);
        Apply(doc, bs, row);
        return bs;
    }

    static void Apply(Document doc, BeamSystem bs, Dictionary<string, string?> row)
    {
        if (ImportGeometry.FtOrNull(row.GetValueOrDefault("spacing")) is { } sp && sp > 0)
            bs.LayoutRule = new LayoutRuleMaximumSpacing(sp);
        if (TypeResolver.ResolveNamedSymbol(doc, row.GetValueOrDefault("type_id"), BuiltInCategory.OST_StructuralFraming) is { } sym)
            bs.BeamType = sym;
    }

    protected override void UpdateElement(Document doc, Dictionary<string, string?> row, Element element)
    {
        if (element is BeamSystem bs) Apply(doc, bs, row);
        SetMark(element, row);
    }
}

/// <summary>
/// Plan text notes and tags on each level's floor plan. A note / tag already in
/// the view at the same spot (or on the same host) is reused, so re-imports do
/// not stack copies (annotation categories cannot carry the BimDown_Id parameter).
/// </summary>
class AnnotationImporter(string table) : TableImporterBase(table, 40,
    table == "text_note" ? [BuiltInCategory.OST_TextNotes] : [BuiltInCategory.OST_RoomTags, BuiltInCategory.OST_DoorTags, BuiltInCategory.OST_WindowTags, BuiltInCategory.OST_WallTags, BuiltInCategory.OST_MultiCategoryTags])
{
    static Dictionary<ElementId, ViewPlan>? _views;

    public static void Reset() => _views = null;

    static ViewPlan PlanOf(Document doc, ElementId levelId)
    {
        _views ??= AnnotationTableExporter.PlanViews(doc);
        return _views.TryGetValue(levelId, out var v) ? v : throw new InvalidOperationException("no floor plan for the level");
    }

    protected override Element? CreateElement(Document doc, Dictionary<string, string?> row)
    {
        var level = IdMap.ResolveLevel(doc, row.GetValueOrDefault("level_id"))
            ?? throw new InvalidOperationException("level_id is required (plan annotations only)");
        var view = PlanOf(doc, level.Id);
        if (TableName == "text_note")
        {
            var pt = new XYZ(ImportGeometry.Ft(row.GetValueOrDefault("x")), ImportGeometry.Ft(row.GetValueOrDefault("y")), level.Elevation);
            var text = (row.GetValueOrDefault("text") ?? "").Replace("\\n", "\r");
            var existing = new FilteredElementCollector(doc, view.Id).OfClass(typeof(TextNote)).Cast<TextNote>()
                .FirstOrDefault(t => t.Text.TrimEnd('\r') == text && new XYZ(t.Coord.X, t.Coord.Y, pt.Z).DistanceTo(pt) < 0.01);
            if (existing is not null) return existing;
            var opts = new TextNoteOptions(NoteType(doc, UnitConverter.ParseNullableDouble(row.GetValueOrDefault("paper_size"))))
            {
                Rotation = UnitConverter.AngleToRadians(UnitConverter.ParseNullableDouble(row.GetValueOrDefault("rotation")) ?? 0),
                HorizontalAlignment = HorizontalTextAlignment.Center,
            };
            return TextNote.Create(doc, view.Id, pt, text, opts);
        }

        var hostId = IdMap.Resolve(doc, row.GetValueOrDefault("host_id")) ?? throw new InvalidOperationException("host_id does not resolve");
        var host = doc.GetElement(hostId);
        var at = row.GetValueOrDefault("x") is not null
            ? new XYZ(ImportGeometry.Ft(row["x"]), ImportGeometry.Ft(row.GetValueOrDefault("y")), level.Elevation)
            : host.Location is LocationPoint lp ? lp.Point
            : host.get_BoundingBox(null) is { } bb ? (bb.Min + bb.Max) / 2 : XYZ.Zero;
        if (host is Room room)
        {
            var existingTag = new FilteredElementCollector(doc, view.Id).OfClass(typeof(SpatialElementTag)).OfType<RoomTag>()
                .FirstOrDefault(t => t.TaggedLocalRoomId == room.Id);
            return existingTag ?? (Element)doc.Create.NewRoomTag(new LinkElementId(room.Id), new UV(at.X, at.Y), view.Id);
        }
        var existingIt = new FilteredElementCollector(doc, view.Id).OfClass(typeof(IndependentTag)).Cast<IndependentTag>()
            .FirstOrDefault(t => t.GetTaggedLocalElementIds().Contains(hostId));
        return existingIt ?? IndependentTag.Create(doc, view.Id, new Reference(host), false, TagMode.TM_ADDBY_CATEGORY, TagOrientation.Horizontal, at);
    }

    static ElementId NoteType(Document doc, double? paperMm)
    {
        var fallback = doc.GetDefaultElementTypeId(ElementTypeGroup.TextNoteType);
        if (paperMm is not { } mm) return fallback;
        var best = new FilteredElementCollector(doc).OfClass(typeof(TextNoteType)).Cast<TextNoteType>()
            .Select(t => (t, Size: UnitConverter.Length(t.get_Parameter(BuiltInParameter.TEXT_SIZE)?.AsDouble() ?? 0) * 1000))
            .OrderBy(x => Math.Abs(x.Size - mm)).FirstOrDefault();
        return best.t?.Id ?? fallback;
    }

    protected override void UpdateElement(Document doc, Dictionary<string, string?> row, Element element)
    {
        if (element is TextNote tn && row.GetValueOrDefault("text") is { } text)
            tn.Text = text.Replace("\\n", "\r");
    }
}

/// <summary>
/// Power circuits: the devices whose circuit_id is this circuit are put on one
/// ElectricalSystem, fed from the host panel.
/// </summary>
class CircuitImporter() : TableImporterBase("circuit", 35, [BuiltInCategory.OST_ElectricalCircuit])
{
    protected override Element? CreateElement(Document doc, Dictionary<string, string?> row)
    {
        var id = row.GetValueOrDefault("id");
        var dir = row.GetValueOrDefault("_dir");
        var members = new List<ElementId>();
        foreach (var table in new[] { "equipment", "terminal" })
        {
            foreach (var d in ImportContext.Rows.GetValueOrDefault(table) ?? [])
            {
                if (d.GetValueOrDefault("circuit_id") != id || d.GetValueOrDefault("_dir") != dir) continue;
                if (IdMap.Resolve(doc, d.GetValueOrDefault("id")) is { } eid) members.Add(eid);
            }
        }
        if (members.Count == 0) throw new InvalidOperationException("no device on this circuit resolves");
        var sys = ElectricalSystem.Create(doc, members, ElectricalSystemType.PowerCircuit);
        if (IdMap.Resolve(doc, row.GetValueOrDefault("host_id")) is { } panelId && doc.GetElement(panelId) is FamilyInstance panel)
            sys.SelectPanel(panel);
        if (row.GetValueOrDefault("name") is { } name) sys.LoadName = name;
        return sys;
    }

    protected override void UpdateElement(Document doc, Dictionary<string, string?> row, Element element)
    {
        if (element is ElectricalSystem sys && row.GetValueOrDefault("name") is { } name) sys.LoadName = name;
    }
}
