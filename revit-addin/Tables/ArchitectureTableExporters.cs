using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Structure;
using BimDown.RevitAddin.Extractors;
using BimDown.RevitAddin.Mapping;
using static BimDown.RevitAddin.Extractors.ParameterUtils;
using static BimDown.RevitAddin.RevitReaders;

namespace BimDown.RevitAddin.Tables;

public static class ArchitectureTableExporters
{
    static readonly string[] Geometry2D = ["start_x", "start_y", "end_x", "end_y", "length", "_svg_d"];
    static readonly string[] Geometry3D = [.. Geometry2D, "start_z", "end_z", "_path"];
    static readonly string[] Boundary = ["boundary_walls", "boundary_face", "boundary_offset"];

    // ─── Walls ───────────────────────────────────────────────────────────

    /// <summary>
    /// wall / structure_wall: thickness, type_id (wall_type with layers),
    /// top_attach_id (Revit Attach Top to a roof / floor). A wall whose exterior
    /// (Wall.Orientation) lies right of its location line is written reversed so
    /// the exterior face — type_layer seq 1 — is on its left, as the spec defines.
    /// </summary>
    internal static CompositeExtractor WallExtractor(bool structural) => new(
        [.. CompositeExtractor.ExpandLineElement(), new VerticalSpanExtractor(), new MaterializedExtractor(), new TypeIdExtractor()],
        structural ? ["thickness", "top_attach_id", "material_grade"] : ["thickness", "top_attach_id"],
        e =>
        {
            var f = new Dictionary<string, string?>();
            if (e is not Wall w) return f;
            f["thickness"] = Names.Num(M(w.Width), 4);
            var layers = Layers(e.Document, w.WallType.GetCompoundStructure());
            if (layers.Count > 0) f["material"] = LayerMapper.PrimaryMaterial(layers);
            f["top_attach_id"] = TopAttachment(w);
            if (structural) f["material_grade"] = MaterialMapper.MaterialGrade(StructuralMaterialName(e));
            return f;
        },
        post: (e, row) =>
        {
            if (e is Wall w && IsReversed(w)) WallMapper.ReverseLine(row);
        });

    static string? TopAttachment(Wall w)
    {
        try
        {
            foreach (var id in w.GetAttachmentIds(AttachmentLocation.Top))
                if (w.Document.GetElement(id) is RoofBase or Floor) return w.Document.GetElement(id).UniqueId;
        }
        catch { /* older documents / unsupported walls */ }
        return null;
    }

    public static ITableExporter Wall() => new TableExporter(
        "wall",
        [BuiltInCategory.OST_Walls],
        WallExtractor(structural: false),
        e => e is Wall w && w.WallType.Kind == WallKind.Basic &&
             w.StructuralUsage == StructuralWallUsage.NonBearing);

    // ─── Columns ─────────────────────────────────────────────────────────

    public static ITableExporter Column() => new TableExporter(
        "column",
        [BuiltInCategory.OST_Columns],
        new CompositeExtractor(
            [.. CompositeExtractor.ExpandPointElement(), new VerticalSpanExtractor(), new MaterializedExtractor(), new TypeIdExtractor()],
            ["shape", "size_x", "size_y"],
            e => e is FamilyInstance fi
                ? SectionMapper.ToArchitectural(SectionMapper.Map(Section(fi.Symbol)))
                : new SectionProfileExtractor().Extract(e)));

    // ─── Slabs, roofs, ceilings ──────────────────────────────────────────

    /// <summary>
    /// The "Pick Walls" association: when the outline runs along the walls of its
    /// level at one face (moved out by one offset), boundary_walls / _face / _offset
    /// are written so editors keep the outline on the walls.
    /// </summary>
    internal static void ApplyBoundary(Element e, Dictionary<string, string?> row, string defaultFace)
    {
        try
        {
            if (row.GetValueOrDefault("points") is not { } json || e.LevelId == ElementId.InvalidElementId) return;
            var pts = JsonSerializer.Deserialize<double[][]>(json);
            if (pts is null || pts.Length < 3) return;
            var poly = pts.Select(p => (p[0], p[1])).ToList();
            var walls = ExportContext.WallsNear(e.Document, e.LevelId);
            if (WallMapper.MatchBoundary(poly, walls, defaultFace) is { } b)
                WallMapper.Apply(row, b, defaultFace);
        }
        catch { /* keep the sketched outline */ }
    }

    internal static CompositeExtractor SlabExtractor(bool structural) => new(
        [.. CompositeExtractor.ExpandPolygonElement(), new MaterializedExtractor(), new TypeIdExtractor()],
        structural ? ["function", "thickness", "material_grade", "span_direction", .. Boundary] : ["function", "thickness", .. Boundary],
        e =>
        {
            var f = new Dictionary<string, string?> { ["function"] = StructureTableExporters.SlabFunction(e) };
            var thickness = e.get_Parameter(BuiltInParameter.FLOOR_ATTR_THICKNESS_PARAM)?.AsDouble();
            f["thickness"] = thickness is { } t ? Names.Num(M(t), 4) : null;
            if (e is Floor floor)
            {
                var cs = floor.FloorType.GetCompoundStructure();
                var layers = Layers(e.Document, cs);
                if (layers.Count > 0) f["material"] = LayerMapper.PrimaryMaterial(layers);
                if (structural)
                {
                    f["material_grade"] = MaterialMapper.MaterialGrade(StructuralMaterialName(e));
                    // A metal deck spans one way: its span direction is meaningful.
                    if (cs?.HasStructuralDeck == true)
                        f["span_direction"] = Names.Num(UnitConverter.Angle(floor.SpanDirectionAngle), 2);
                }
            }
            return f;
        },
        post: (e, row) => ApplyBoundary(e, row, "core"));

    public static ITableExporter Slab() => new TableExporter(
        "slab",
        [BuiltInCategory.OST_Floors],
        SlabExtractor(structural: false),
        e => e is Floor floor && floor.get_Parameter(BuiltInParameter.FLOOR_PARAM_IS_STRUCTURAL)?.AsInteger() != 1);

    public static ITableExporter Roof() => new TableExporter(
        "roof",
        [BuiltInCategory.OST_Roofs],
        new CompositeExtractor(
            [.. CompositeExtractor.ExpandPolygonElement(), new MaterializedExtractor(), new TypeIdExtractor()],
            ["roof_type", "slope", "edge_slopes", "profile", "thickness", .. Boundary],
            RoofFields,
            post: (e, row) =>
            {
                if (row.GetValueOrDefault("roof_type") != "extrusion") ApplyBoundary(e, row, "exterior");
            }));

    static Dictionary<string, string?> RoofFields(Element e)
    {
        var f = new Dictionary<string, string?>();
        var thickness = e.get_Parameter(BuiltInParameter.ROOF_ATTR_THICKNESS_PARAM)?.AsDouble();
        f["thickness"] = thickness is { } t ? Names.Num(M(t), 4) : null;
        if (e is RoofBase rb && Layers(e.Document, rb.RoofType.GetCompoundStructure()) is { Count: > 0 } layers)
            f["material"] = LayerMapper.PrimaryMaterial(layers);

        if (e is ExtrusionRoof er && ExtrusionFields(er, thickness is { } th ? M(th) : 0) is { } ex)
        {
            foreach (var kv in ex) f[kv.Key] = kv.Value;
            return f;
        }

        // Footprint roof: the sketch outline with one slope per edge (Revit "Defines Slope").
        try
        {
            if (e is FootPrintRoof fp && FootprintWithSlopes(fp) is { } fps)
            {
                f["points"] = GeometryUtils.SerializePolygon(fps.Points);
                if (fps.HasCurvedEdges) f["_has_curved_edges"] = "true";
                var shape = RoofMapper.Classify(fps.SlopesDeg);
                f["roof_type"] = shape.RoofType;
                f["slope"] = Names.Num(shape.Slope, 2);
                f["edge_slopes"] = shape.EdgeSlopes;
                return f;
            }
        }
        catch { /* fall back to the solid outline */ }

        try
        {
            if (RoofGeometry.OutlineFromSolid(e) is { } outline)
            {
                f["points"] = GeometryUtils.SerializePolygon(outline.Points);
                if (outline.HasCurvedEdges) f["_has_curved_edges"] = "true";
            }
        }
        catch { /* keep PolygonElementExtractor result */ }
        f["roof_type"] = "flat";
        f["slope"] = "0";
        return f;
    }

    /// <summary>
    /// Footprint sketch chained into one ring, with each edge's slope in degrees
    /// (null where the edge does not define a slope). FootPrintRoof.SlopeAngle is
    /// a rise / run tangent despite its name.
    /// </summary>
    static (List<XYZ> Points, List<double?> SlopesDeg, bool HasCurvedEdges)? FootprintWithSlopes(FootPrintRoof roof)
    {
        var edges = new List<(XYZ Start, XYZ End, bool Curved, double? Slope)>();
        foreach (ModelCurveArray profile in roof.GetProfiles())
        {
            foreach (ModelCurve mc in profile)
            {
                var c = mc.GeometryCurve;
                double? slope = roof.get_DefinesSlope(mc) ? RoofMapper.SlopeTangentToDegrees(roof.get_SlopeAngle(mc)) : null;
                edges.Add((c.GetEndPoint(0), c.GetEndPoint(1), c is not Line, slope));
            }
        }
        if (edges.Count < 3) return null;

        const double tol = 1e-3;
        var points = new List<XYZ> { edges[0].Start };
        var slopes = new List<double?> { edges[0].Slope };
        var curved = edges[0].Curved;
        var current = edges[0].End;
        var used = new HashSet<int> { 0 };
        while (used.Count < edges.Count)
        {
            var next = -1;
            var reversed = false;
            for (var i = 0; i < edges.Count && next < 0; i++)
            {
                if (used.Contains(i)) continue;
                if (edges[i].Start.DistanceTo(current) < tol) next = i;
                else if (edges[i].End.DistanceTo(current) < tol) { next = i; reversed = true; }
            }
            if (next < 0) break; // a second loop (hole) — the outer ring is enough
            used.Add(next);
            points.Add(current);
            slopes.Add(edges[next].Slope);
            curved |= edges[next].Curved;
            current = reversed ? edges[next].Start : edges[next].End;
        }
        if (points.Count < 3 || current.DistanceTo(points[0]) > tol) return null;
        return (points, slopes, curved);
    }

    static Dictionary<string, string?>? ExtrusionFields(ExtrusionRoof roof, double thickness)
    {
        try
        {
            var profile = roof.GetProfile();
            if (profile.Size == 0) return null;
            var plane = profile.get_Item(0).SketchPlane.GetPlane();
            // The horizontal axis of the vertical profile plane.
            var h = Math.Abs(plane.XVec.Z) < Math.Abs(plane.YVec.Z) ? plane.XVec : plane.YVec;
            var n = plane.Normal;
            var levelZ = (roof.Document.GetElement(roof.LevelId) as Level)?.Elevation ?? 0;
            var pts = new List<(double H, double Z)>();
            foreach (ModelCurve mc in profile)
                foreach (var p in mc.GeometryCurve.Tessellate())
                    pts.Add((M((p - plane.Origin).DotProduct(h)), M(p.Z - levelZ)));
            var start = roof.get_Parameter(BuiltInParameter.EXTRUSION_START_PARAM)?.AsDouble() ?? 0;
            var end = roof.get_Parameter(BuiltInParameter.EXTRUSION_END_PARAM)?.AsDouble() ?? 0;
            var ex = RoofMapper.Extrusion(pts, thickness, (M(plane.Origin.X), M(plane.Origin.Y)),
                (h.X, h.Y), (n.X, n.Y), M(start), M(end));
            return new Dictionary<string, string?>
            {
                ["roof_type"] = "extrusion",
                ["slope"] = null,
                ["profile"] = ex.Profile,
                ["points"] = "[" + string.Join(",", ex.Footprint.Select(p => $"[{Names.Num(p.X)},{Names.Num(p.Y)}]")) + "]",
                ["base_offset"] = Names.Num(ex.BaseOffset, 3),
            };
        }
        catch { return null; }
    }

    public static ITableExporter Ceiling() => new TableExporter(
        "ceiling",
        [BuiltInCategory.OST_Ceilings],
        new CompositeExtractor(
            [.. CompositeExtractor.ExpandPolygonElement(), new MaterializedExtractor(), new TypeIdExtractor()],
            ["height_offset", .. Boundary],
            e =>
            {
                var fields = new Dictionary<string, string?>();
                var offset = e.get_Parameter(BuiltInParameter.CEILING_HEIGHTABOVELEVEL_PARAM)?.AsDouble();
                fields["height_offset"] = offset is { } o ? Names.Num(M(o), 3) : null;
                if (e.Document.GetElement(e.GetTypeId()) is CeilingType ct && Layers(e.Document, ct.GetCompoundStructure()) is { Count: > 0 } layers)
                    fields["material"] = LayerMapper.PrimaryMaterial(layers);
                return fields;
            },
            // height_offset is a geojson_property (stored in the GeoJSON Feature props).
            geoJsonInlineFieldNames: ["height_offset"],
            post: (e, row) => ApplyBoundary(e, row, "interior")));

    public static ITableExporter Opening() => new OpeningTableExporter();

    public static ITableExporter Space() => new TableExporter(
        "space",
        [BuiltInCategory.OST_Rooms],
        new CompositeExtractor(
            [new ElementExtractor()],
            ["x", "y", "name"],
            e =>
            {
                var fields = new Dictionary<string, string?>
                {
                    ["name"] = e.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString() ?? e.Name,
                };
                if (e.Location is LocationPoint lp)
                {
                    fields["x"] = UnitConverter.FormatDouble(M(lp.Point.X));
                    fields["y"] = UnitConverter.FormatDouble(M(lp.Point.Y));
                }
                return fields;
            }),
        // Required seed point (x,y) comes from the room's LocationPoint. Unplaced /
        // unenclosed rooms have no location and no boundary — skip them.
        filter: e => e.Location is LocationPoint);

    // ─── Doors and windows ───────────────────────────────────────────────

    /// <summary>Door / panel families that fill a curtain wall cell (exported as curtain_wall.panels).</summary>
    internal static bool IsCurtainPanel(Element e) =>
        e is FamilyInstance fi && (fi.Host is Wall { WallType.Kind: WallKind.Curtain } || fi.Host is Autodesk.Revit.DB.Panel);

    /// <summary>
    /// Hosted door / window extractor: sill height is the CSV base_offset, and on a
    /// wall exported reversed the position counts from the other end.
    /// </summary>
    static CompositeExtractor HostedExtractor(string[] fields, Func<Element, Dictionary<string, string?>> extract) => new(
        [.. CompositeExtractor.ExpandHostedElement(), new MaterializedExtractor(), new TypeIdExtractor()],
        fields,
        extract,
        post: (e, row) =>
        {
            var sill = e.get_Parameter(BuiltInParameter.INSTANCE_SILL_HEIGHT_PARAM)?.AsDouble();
            if (sill is { } s) row["base_offset"] = Names.Num(M(s), 3);
            if (row.GetValueOrDefault("base_offset") is "0") row["base_offset"] = null;
            if (e is FamilyInstance { Host: Wall host } && IsReversed(host) && host.Location is LocationCurve lc)
                WallMapper.ReverseHosted(row, M(lc.Curve.Length));
        },
        csvFieldNames: ["base_offset"]);

    public static ITableExporter Door() => new TableExporter(
        "door",
        [BuiltInCategory.OST_Doors],
        HostedExtractor(["width", "height", "operation", "hinge_position", "swing_side"], e =>
        {
            var fields = new Dictionary<string, string?>();
            var w = e.get_Parameter(BuiltInParameter.DOOR_WIDTH).AsPositiveDouble()
                 ?? e.get_Parameter(BuiltInParameter.FAMILY_WIDTH_PARAM).AsPositiveDouble()
                 ?? FindDoubleParameterByNames(e, "width", "w", "b", "宽");
            var h = e.get_Parameter(BuiltInParameter.DOOR_HEIGHT).AsPositiveDouble()
                 ?? e.get_Parameter(BuiltInParameter.FAMILY_HEIGHT_PARAM).AsPositiveDouble()
                 ?? FindDoubleParameterByNames(e, "height", "h", "高");
            fields["width"] = w is { } wv ? Names.Num(M(wv), 3) : null;
            fields["height"] = h is { } hv ? Names.Num(M(hv), 3) : null;
            if (e is FamilyInstance fi)
            {
                fields["operation"] = OpeningMapper.DoorOperation(
                    FindStringParameterByNames(e, "Operation", "Swing", "操作", "开启"), fi.Symbol.FamilyName, fi.Symbol.Name);
                // Hinge side and swing direction from FamilyInstance flip state
                fields["hinge_position"] = fi.HandFlipped ? "end" : "start";
                fields["swing_side"] = fi.FacingFlipped ? "right" : "left";
            }
            return fields;
        }),
        e => !IsCurtainPanel(e));

    public static ITableExporter Window() => new TableExporter(
        "window",
        [BuiltInCategory.OST_Windows],
        HostedExtractor(["width", "height", "operation"], e =>
        {
            var fields = new Dictionary<string, string?>();
            var w = e.get_Parameter(BuiltInParameter.WINDOW_WIDTH).AsPositiveDouble()
                 ?? e.get_Parameter(BuiltInParameter.FAMILY_WIDTH_PARAM).AsPositiveDouble()
                 ?? FindDoubleParameterByNames(e, "width", "w", "b", "宽");
            var h = e.get_Parameter(BuiltInParameter.WINDOW_HEIGHT).AsPositiveDouble()
                 ?? e.get_Parameter(BuiltInParameter.FAMILY_HEIGHT_PARAM).AsPositiveDouble()
                 ?? FindDoubleParameterByNames(e, "height", "h", "高");
            fields["width"] = w is { } wv ? Names.Num(M(wv), 3) : null;
            fields["height"] = h is { } hv ? Names.Num(M(hv), 3) : null;
            if (e is FamilyInstance fi)
                fields["operation"] = OpeningMapper.WindowOperation(
                    FindStringParameterByNames(e, "operation", "Operation", "开启方式"), fi.Symbol.FamilyName, fi.Symbol.Name);
            return fields;
        }),
        e => !IsCurtainPanel(e));

    // ─── Stairs ──────────────────────────────────────────────────────────

    public static ITableExporter Stair() => new TableExporter(
        "stair",
        [BuiltInCategory.OST_Stairs],
        new CompositeExtractor(
            [new ElementExtractor(), new VerticalSpanExtractor(), new MaterializedExtractor()],
            ["width", "step_count", "stair_type", "multistory_top_level_id", .. Geometry3D],
            e => StairReader.StairFields(e),
            computedInlineFieldNames: Geometry3D),
        e => e is not Stairs s || ExportContext.IsStairExported(s));

    public static ITableExporter StairRun() => new StairReader.RunExporter();

    public static ITableExporter StairLanding() => new StairReader.LandingExporter();

    public static ITableExporter CurtainWall() => new TableExporter(
        "curtain_wall",
        [BuiltInCategory.OST_Walls],
        new CompositeExtractor(
            [.. CompositeExtractor.ExpandLineElement(), new VerticalSpanExtractor(), new MaterializedExtractor(), new TypeIdExtractor()],
            ["u_grid_count", "v_grid_count", "u_grids", "v_grids", "panels", "door_numbers", "panel_count",
             "u_spacing", "v_spacing", "panel_material", "solid_material", "mullion_width", "mullion_depth", "mullion_profile"],
            CurtainWallFields,
            ["panel_count"]),
        e => e is Wall w && w.WallType.Kind == WallKind.Curtain);

    static Dictionary<string, string?> CurtainWallFields(Element e)
    {
        var fields = new Dictionary<string, string?>();
        if (e is not Wall w || w.CurtainGrid is not { } grid || w.Location is not LocationCurve { Curve: var curve }) return fields;
        var doc = e.Document;
        var start = curve.GetEndPoint(0);
        var dir = (curve.GetEndPoint(1) - start).Normalize();
        var baseZ = ((doc.GetElement(w.LevelId) as Level)?.Elevation ?? 0)
                    + (w.get_Parameter(BuiltInParameter.WALL_BASE_OFFSET)?.AsDouble() ?? 0);
        var height = w.get_Parameter(BuiltInParameter.WALL_USER_HEIGHT_PARAM)?.AsDouble()
                     ?? (w.get_BoundingBox(null) is { } bb ? bb.Max.Z - baseZ : 0);
        double Along(XYZ p) => M((p - start).DotProduct(dir));

        var u = new List<double>();
        var v = new List<double>();
        foreach (var id in grid.GetUGridLineIds().Concat(grid.GetVGridLineIds()))
        {
            if (doc.GetElement(id) is not CurtainGridLine gl) continue;
            var mid = gl.FullCurve.Evaluate(0.5, true);
            if (gl.IsUGridLine) u.Add(M(mid.Z - baseZ));
            else v.Add(Along(mid));
        }

        var panels = new List<CurtainPanel>();
        foreach (var id in grid.GetPanelIds())
        {
            var p = doc.GetElement(id);
            if (p?.get_BoundingBox(null) is not { } pb) continue;
            var c = (pb.Min + pb.Max) / 2;
            var isDoor = p.Category?.BuiltInCategory == BuiltInCategory.OST_Doors;
            var (fam, typ) = p is FamilyInstance fi ? (fi.Symbol.FamilyName, fi.Symbol.Name)
                : (doc.GetElement(p.GetTypeId()) is ElementType et ? (et.FamilyName, et.Name) : ("", p.Name));
            var mat = MaterialName(doc, doc.GetElement(p.GetTypeId())?.get_Parameter(BuiltInParameter.MATERIAL_ID_PARAM)?.AsElementId());
            var kind = CurtainGridMapper.PanelKind(isDoor, fam, typ, mat);
            var mark = isDoor ? p.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.AsString() : null;
            panels.Add(new CurtainPanel(Along(c), M(c.Z - baseZ), kind, mark));
        }

        foreach (var kv in CurtainGridMapper.Map(M(curve.Length), M(height), v, u, panels))
            fields[kv.Key] = kv.Value;
        fields["panel_count"] = grid.GetPanelIds().Count.ToString();
        fields["panel_material"] = MaterialMapper.MapToEnum(GetDominantPanelMaterial(doc, grid.GetPanelIds()) ?? "glass");
        return fields;
    }

    static string? GetDominantPanelMaterial(Document doc, ICollection<ElementId> panelIds) =>
        panelIds
            .Select(id => doc.GetElement(id))
            .Where(p => p is not null)
            .SelectMany(p => p.GetMaterialIds(false))
            .Select(id => doc.GetElement(id) as Material)
            .Where(m => m is not null)
            .GroupBy(m => m!.Name)
            .OrderByDescending(g => g.Count())
            .FirstOrDefault()?.Key;

    public static ITableExporter Ramp() => new TableExporter(
        "ramp",
        [BuiltInCategory.OST_Ramps],
        new CompositeExtractor(
            CompositeExtractor.ExpandSpatialLineElement(),
            ["width"],
            e =>
            {
                var width = e.get_Parameter(BuiltInParameter.STAIRS_ATTR_TREAD_WIDTH).AsPositiveDouble()
                         ?? FindDoubleParameterByNames(e, "width", "w", "宽");
                return new Dictionary<string, string?>
                {
                    ["width"] = width is { } w ? UnitConverter.FormatDouble(M(w)) : null
                };
            }));

    // ─── Railings ────────────────────────────────────────────────────────

    /// <summary>
    /// Railings: on a stair → host_id + side, no geometry (the path is derived
    /// from the stair); on a floor → host_id + its path; otherwise the sketched
    /// path as a 3D LineString with every vertex. Railings of the repeated storeys
    /// of a multistory stair are generated from the exported one.
    /// </summary>
    public static ITableExporter Railing() => new TableExporter(
        "railing",
        [BuiltInCategory.OST_StairsRailing],
        new CompositeExtractor(
            [new ElementExtractor(), new MaterializedExtractor(), new TypeIdExtractor()],
            ["height", "host_id", "side", "baluster_spacing", .. Geometry3D],
            RailingFields,
            computedInlineFieldNames: Geometry3D),
        e => e is not Railing r || r.HostId == ElementId.InvalidElementId
             || r.Document.GetElement(r.HostId) is not Stairs s || ExportContext.IsStairExported(s));

    static Dictionary<string, string?> RailingFields(Element e)
    {
        var f = new Dictionary<string, string?>();
        if (e is not Railing r) return f;
        var doc = e.Document;
        var curves = r.GetPath().ToList();
        var pts = new List<XYZ>();
        foreach (var c in curves)
        {
            var tess = c.Tessellate();
            foreach (var p in tess)
                if (pts.Count == 0 || pts[^1].DistanceTo(p) > 1e-4) pts.Add(p);
        }
        var host = r.HostId != ElementId.InvalidElementId ? doc.GetElement(r.HostId) : null;
        if (host is Stairs stairs)
        {
            f["host_id"] = stairs.UniqueId;
            var runs = StairReader.Runs(stairs);
            if (runs.Count > 0 && pts.Count > 0)
            {
                var mid = pts[pts.Count / 2];
                f["side"] = StairMapper.RailingSide(runs[0], M(mid.X), M(mid.Y));
            }
            // Level of the stair, so the railing lands in the same directory.
            f["level_id"] = LevelUid(doc, stairs.get_Parameter(BuiltInParameter.STAIRS_BASE_LEVEL_PARAM)?.AsElementId());
            f["top_level_id"] = LevelUid(doc, stairs.get_Parameter(BuiltInParameter.STAIRS_TOP_LEVEL_PARAM)?.AsElementId());
            return f;
        }
        if (host is Floor) f["host_id"] = host.UniqueId;
        if (pts.Count >= 2)
        {
            var a = pts[0];
            var b = pts[^1];
            f["start_x"] = Names.Num(M(a.X)); f["start_y"] = Names.Num(M(a.Y)); f["start_z"] = Names.Num(M(a.Z));
            f["end_x"] = Names.Num(M(b.X)); f["end_y"] = Names.Num(M(b.Y)); f["end_z"] = Names.Num(M(b.Z));
            f["_path"] = "[" + string.Join(",", pts.Select(p => $"[{Names.Num(M(p.X), 4)},{Names.Num(M(p.Y), 4)},{Names.Num(M(p.Z), 4)}]")) + "]";
        }
        return f;
    }

    public static ITableExporter RoomSeparator() => new TableExporter(
        "room_separator",
        [BuiltInCategory.OST_RoomSeparationLines],
        new CompositeExtractor(CompositeExtractor.ExpandLineElement()));

    // ─── Furniture ───────────────────────────────────────────────────────

    /// <summary>Point families without MEP connectors that are not nested in another family.</summary>
    internal static bool IsFurniture(Element e) =>
        e is FamilyInstance { SuperComponent: null } fi && fi.Location is LocationPoint
        && (fi.MEPModel?.ConnectorManager?.Connectors is not { Size: > 0 });

    /// <summary>
    /// Furniture, casework, planting, entourage, parking and specialty families →
    /// the furniture table: library family + variant guessed from the names
    /// (generic_box otherwise), sizes from the family bounding box, the point at the
    /// footprint centre (Revit families sit at their insertion point).
    /// </summary>
    public static ITableExporter Furniture() => new TableExporter(
        "furniture",
        TypeTableExporters.FurnitureCategories,
        new CompositeExtractor(
            [.. CompositeExtractor.ExpandPointElement(), new TypeIdExtractor()],
            ["family", "variant", "size_x", "size_y", "height", "mirror"],
            e =>
            {
                var f = new Dictionary<string, string?>();
                if (e is not FamilyInstance fi) return f;
                var guess = FurnitureMapper.Guess(fi.Symbol.FamilyName, fi.Symbol.Name, fi.Category?.Name);
                f["family"] = guess.Family;
                f["variant"] = guess.Variant;
                f["mirror"] = fi.Mirrored ? "true" : null;
                if (fi.Symbol.get_BoundingBox(null) is { } bb && fi.Location is LocationPoint lp)
                {
                    f["size_x"] = Names.Num(M(bb.Max.X - bb.Min.X), 3);
                    f["size_y"] = Names.Num(M(bb.Max.Y - bb.Min.Y), 3);
                    f["height"] = Names.Num(M(bb.Max.Z - bb.Min.Z), 3);
                    var (cx, cy) = FurnitureMapper.FootprintCenter(M(lp.Point.X), M(lp.Point.Y), lp.Rotation,
                        M(bb.Min.X), M(bb.Max.X), M(bb.Min.Y), M(bb.Max.Y), fi.Mirrored);
                    f["x"] = Names.Num(cx);
                    f["y"] = Names.Num(cy);
                }
                return f;
            },
            post: (_, row) =>
            {
                // Sizes are CSV fields here; no `size` GeoJSON property from the bbox.
                foreach (var k in new[] { "bbox_min_x", "bbox_min_y", "bbox_min_z", "bbox_max_x", "bbox_max_y", "bbox_max_z" })
                    row.Remove(k);
            }),
        IsFurniture);

    // ─── Model groups ────────────────────────────────────────────────────

    public static ITableExporter ModelGroup() => new TableExporter(
        "model_group",
        [BuiltInCategory.OST_IOSModelGroups],
        new CompositeExtractor(
            [new ElementExtractor()],
            ["name", "x", "y", "rotation", "mirrored"],
            e =>
            {
                var f = new Dictionary<string, string?>();
                if (e is not Group g) return f;
                f["name"] = g.GroupType?.Name ?? g.Name;
                if (g.Location is LocationPoint lp)
                {
                    f["x"] = Names.Num(M(lp.Point.X));
                    f["y"] = Names.Num(M(lp.Point.Y));
                    var rot = UnitConverter.Angle(lp.Rotation);
                    f["rotation"] = Math.Abs(rot) < 1e-6 ? null : Names.Num(rot, 3);
                }
                return f;
            },
            post: (_, row) => row.Remove("group_id")),
        e => e is Group { GroupId.Value: < 0 });
}
