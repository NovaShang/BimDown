using Autodesk.Revit.DB;
using BimDown.RevitAddin.Extractors;
using static BimDown.RevitAddin.Extractors.ParameterUtils;

namespace BimDown.RevitAddin.Tables;

public static class ArchitectureTableExporters
{
    public static ITableExporter Wall() => new TableExporter(
        "wall",
        [BuiltInCategory.OST_Walls],
        new CompositeExtractor(
            [..CompositeExtractor.ExpandLineElement(), new VerticalSpanExtractor(), new MaterializedExtractor()],
            ["thickness"],
            e => new Dictionary<string, string?>
            {
                ["thickness"] = e is Wall w
                    ? UnitConverter.FormatDouble(UnitConverter.Length(w.Width))
                    : null
            }),
        e => e is Wall w && w.WallType.Kind == WallKind.Basic &&
             w.StructuralUsage == Autodesk.Revit.DB.Structure.StructuralWallUsage.NonBearing);

    public static ITableExporter Column() => new TableExporter(
        "column",
        [BuiltInCategory.OST_Columns],
        new CompositeExtractor(
            [..CompositeExtractor.ExpandPointElement(), new VerticalSpanExtractor(), new MaterializedExtractor(), new SectionProfileExtractor()]));

    public static ITableExporter Slab() => new TableExporter(
        "slab",
        [BuiltInCategory.OST_Floors],
        new CompositeExtractor(
            [..CompositeExtractor.ExpandPolygonElement(), new MaterializedExtractor()],
            ["function", "thickness"],
            e =>
            {
                var fields = new Dictionary<string, string?>();
                if (e is Floor floor)
                {
                    fields["function"] = "floor";
                    var thickness = floor.get_Parameter(BuiltInParameter.FLOOR_ATTR_THICKNESS_PARAM)?.AsDouble();
                    fields["thickness"] = thickness is { } t ? UnitConverter.FormatDouble(UnitConverter.Length(t)) : null;
                }
                return fields;
            }),
        e =>
        {
            if (e is Floor floor)
            {
                var structural = floor.get_Parameter(BuiltInParameter.FLOOR_PARAM_IS_STRUCTURAL)?.AsInteger();
                return structural != 1;
            }
            return false;
        });

    public static ITableExporter Roof() => new TableExporter(
        "roof",
        [BuiltInCategory.OST_Roofs],
        new CompositeExtractor(
            [..CompositeExtractor.ExpandPolygonElement(), new MaterializedExtractor()],
            ["roof_type", "slope", "thickness"],
            e =>
            {
                var fields = new Dictionary<string, string?>();

                // Slope & roof type: classify FootPrintRoof by per-edge slope definitions
                var (roofType, slopeDeg) = ClassifyRoof(e);
                fields["roof_type"] = roofType;
                fields["slope"] = UnitConverter.FormatDouble(slopeDeg);

                // Thickness from type parameter
                var thickness = e.get_Parameter(BuiltInParameter.ROOF_ATTR_THICKNESS_PARAM)?.AsDouble();
                fields["thickness"] = thickness is { } t ? UnitConverter.FormatDouble(UnitConverter.Length(t)) : null;

                // Polygon override:
                //   1. FootPrintRoof → sketch profile (exact plan-view footprint)
                //   2. Otherwise (or if sketch fails) → derive outline from solid's top faces
                //
                // PolygonElementExtractor's single-largest-top-face result is wrong
                // for multi-slope roofs (gable/hip/complex C-shapes), so we override.
                try
                {
                    var footprint = GetRoofFootprint(e) ?? GetRoofOutlineFromSolid(e);
                    if (footprint is not null)
                    {
                        fields["points"] = GeometryUtils.SerializePolygon(footprint.Value.Points);
                        if (footprint.Value.HasCurvedEdges)
                            fields["_has_curved_edges"] = "true";
                    }
                }
                catch { /* keep PolygonElementExtractor result */ }

                return fields;
            }));

    /// <summary>
    /// Classifies a roof by its per-edge slope definitions.
    /// Returns (roof_type, dominant slope in degrees, signed).
    ///
    /// Revit's FootPrintRoof.get_SlopeAngle(mc) returns the slope as a
    /// tangent (rise/run), NOT radians — despite the name. Negative values
    /// mean the slope descends from that edge (inverted roof). We pick the
    /// edge with the largest |tangent| and convert it back to degrees
    /// using Atan, preserving the sign.
    /// </summary>
    static (string RoofType, double SlopeDeg) ClassifyRoof(Element element)
    {
        if (element is not FootPrintRoof fpRoof)
            return ("flat", 0);

        try
        {
            var profiles = fpRoof.GetProfiles();
            int total = 0, sloped = 0;
            double dominantTan = 0;

            foreach (ModelCurveArray profile in profiles)
            {
                foreach (ModelCurve mc in profile)
                {
                    total++;
                    if (fpRoof.get_DefinesSlope(mc))
                    {
                        sloped++;
                        var tan = fpRoof.get_SlopeAngle(mc);
                        if (Math.Abs(tan) > Math.Abs(dominantTan))
                            dominantTan = tan;
                    }
                }
            }

            var slopeDeg = Math.Atan(dominantTan) * 180.0 / Math.PI;
            string type;
            if (sloped == 0) type = "flat";
            else if (sloped == total) type = "hip";
            else if (sloped == 1) type = "shed";
            else type = "gable";

            return (type, slopeDeg);
        }
        catch
        {
            return ("flat", 0);
        }
    }

    static (IList<XYZ> Points, bool HasCurvedEdges)? GetRoofFootprint(Element element)
    {
        if (element is not FootPrintRoof fpRoof) return null;

        var profiles = fpRoof.GetProfiles();
        if (profiles.Size == 0) return null;

        // Collect all curves from all profile arrays (Revit splits edges by slope definition)
        var edges = new List<(XYZ Start, XYZ End, bool IsCurved)>();
        foreach (ModelCurveArray profile in profiles)
        {
            foreach (ModelCurve mc in profile)
            {
                var curve = mc.GeometryCurve;
                edges.Add((curve.GetEndPoint(0), curve.GetEndPoint(1), curve is not Line));
            }
        }

        if (edges.Count < 3) return null;

        // Chain edges by endpoint matching. Tolerance 1e-3 ft (~0.3mm) handles
        // floating-point drift in sketch profiles without matching unrelated edges.
        const double tolerance = 1e-3;
        var points = new List<XYZ> { edges[0].Start };
        var current = edges[0].End;
        var hasCurvedEdges = edges[0].IsCurved;
        var used = new HashSet<int> { 0 };

        while (used.Count < edges.Count)
        {
            points.Add(current);
            var found = false;
            for (var i = 0; i < edges.Count; i++)
            {
                if (used.Contains(i)) continue;
                if (edges[i].Start.DistanceTo(current) < tolerance)
                {
                    current = edges[i].End;
                    if (edges[i].IsCurved) hasCurvedEdges = true;
                    used.Add(i);
                    found = true;
                    break;
                }
                if (edges[i].End.DistanceTo(current) < tolerance)
                {
                    current = edges[i].Start;
                    if (edges[i].IsCurved) hasCurvedEdges = true;
                    used.Add(i);
                    found = true;
                    break;
                }
            }
            if (!found) break;
        }

        return points.Count >= 3 ? (points, hasCurvedEdges) : null;
    }

    /// <summary>
    /// Derives a roof's plan-view outline from its solid geometry by:
    ///   1. collecting every upward-facing PlanarFace,
    ///   2. counting each edge (keyed by XY-projected endpoints),
    ///   3. keeping edges that appear exactly once (boundary; shared edges
    ///      between two top faces are ridges/hips and are internal),
    ///   4. chaining boundary edges into closed loops and returning the
    ///      largest loop by bounding-box area.
    ///
    /// Works for any roof type (FootPrintRoof, ExtrusionRoof, base RoofBase
    /// with tapered insulation, curved sketches, etc.). Used as a fallback
    /// when GetRoofFootprint can't read a sketch.
    /// </summary>
    static (IList<XYZ> Points, bool HasCurvedEdges)? GetRoofOutlineFromSolid(Element element)
    {
        var opt = new Options { ComputeReferences = false, DetailLevel = ViewDetailLevel.Coarse };
        var geom = element.get_Geometry(opt);
        if (geom is null) return null;

        // 1. Collect top-facing planar faces from all solids.
        var topFaces = new List<PlanarFace>();
        foreach (var obj in geom)
        {
            var solid = obj as Solid ?? (obj as GeometryInstance)?.GetInstanceGeometry()
                .OfType<Solid>().FirstOrDefault(s => s.Faces.Size > 0);
            if (solid is null) continue;
            foreach (Face face in solid.Faces)
                if (face is PlanarFace planar && planar.FaceNormal.Z > 0.1)
                    topFaces.Add(planar);
        }
        if (topFaces.Count == 0) return null;

        // 2+3. Count edges; boundary = appears exactly once across all top faces.
        var edgeMap = new Dictionary<string, (XYZ Start, XYZ End, bool IsCurved, int Count)>();
        foreach (var face in topFaces)
        {
            foreach (var loop in face.GetEdgesAsCurveLoops())
            {
                foreach (var curve in loop)
                {
                    var a = curve.GetEndPoint(0);
                    var b = curve.GetEndPoint(1);
                    var key = MakeEdgeKey(a, b);
                    if (edgeMap.TryGetValue(key, out var existing))
                        edgeMap[key] = (existing.Start, existing.End, existing.IsCurved, existing.Count + 1);
                    else
                        edgeMap[key] = (a, b, curve is not Line, 1);
                }
            }
        }

        // Project boundary edges to XY.
        var boundary = edgeMap.Values
            .Where(v => v.Count == 1)
            .Select(v => (Start: new XYZ(v.Start.X, v.Start.Y, 0),
                          End: new XYZ(v.End.X, v.End.Y, 0),
                          v.IsCurved))
            .ToList();
        if (boundary.Count < 3) return null;

        // 4. Chain into closed loops. A complex roof may yield multiple
        // disconnected loops (outer boundary + holes / tiny artifacts).
        const double tol = 1e-3;
        var used = new bool[boundary.Count];
        var loops = new List<(List<XYZ> Points, bool HasCurved)>();

        while (true)
        {
            var startIdx = -1;
            for (var i = 0; i < boundary.Count; i++) if (!used[i]) { startIdx = i; break; }
            if (startIdx < 0) break;

            var points = new List<XYZ> { boundary[startIdx].Start };
            var current = boundary[startIdx].End;
            var hasCurved = boundary[startIdx].IsCurved;
            used[startIdx] = true;

            while (true)
            {
                points.Add(current);
                var found = -1;
                var reversed = false;
                for (var i = 0; i < boundary.Count; i++)
                {
                    if (used[i]) continue;
                    if (boundary[i].Start.DistanceTo(current) < tol) { found = i; reversed = false; break; }
                    if (boundary[i].End.DistanceTo(current) < tol) { found = i; reversed = true; break; }
                }
                if (found < 0) break;
                used[found] = true;
                if (boundary[found].IsCurved) hasCurved = true;
                current = reversed ? boundary[found].Start : boundary[found].End;
                if (current.DistanceTo(points[0]) < tol) break;
            }
            if (points.Count >= 3) loops.Add((points, hasCurved));
        }

        if (loops.Count == 0) return null;

        // Return the loop with the largest XY bounding-box area (outer boundary).
        var best = loops.OrderByDescending(l =>
        {
            double minX = double.MaxValue, minY = double.MaxValue;
            double maxX = double.MinValue, maxY = double.MinValue;
            foreach (var p in l.Points)
            {
                if (p.X < minX) minX = p.X;
                if (p.X > maxX) maxX = p.X;
                if (p.Y < minY) minY = p.Y;
                if (p.Y > maxY) maxY = p.Y;
            }
            return (maxX - minX) * (maxY - minY);
        }).First();

        return (best.Points, best.HasCurved);
    }

    /// <summary>
    /// Creates a direction-independent key for an edge based on its XY-projected
    /// endpoints. Rounds to 0.001 ft (~0.3mm) to absorb floating-point drift
    /// between coincident vertices on adjacent faces.
    /// </summary>
    static string MakeEdgeKey(XYZ a, XYZ b)
    {
        var ci = System.Globalization.CultureInfo.InvariantCulture;
        var s1 = Math.Round(a.X, 3).ToString("F3", ci) + "," + Math.Round(a.Y, 3).ToString("F3", ci);
        var s2 = Math.Round(b.X, 3).ToString("F3", ci) + "," + Math.Round(b.Y, 3).ToString("F3", ci);
        return string.Compare(s1, s2, StringComparison.Ordinal) < 0 ? s1 + "|" + s2 : s2 + "|" + s1;
    }

    public static ITableExporter Ceiling() => new TableExporter(
        "ceiling",
        [BuiltInCategory.OST_Ceilings],
        new CompositeExtractor(
            [..CompositeExtractor.ExpandPolygonElement(), new MaterializedExtractor()],
            ["height_offset"],
            e =>
            {
                var fields = new Dictionary<string, string?>();
                var offset = e.get_Parameter(BuiltInParameter.CEILING_HEIGHTABOVELEVEL_PARAM)?.AsDouble();
                fields["height_offset"] = offset is { } o ? UnitConverter.FormatDouble(UnitConverter.Length(o)) : null;
                return fields;
            }));

    public static ITableExporter Opening() => new OpeningTableExporter();

    public static ITableExporter Space() => new TableExporter(
        "space",
        [BuiltInCategory.OST_Rooms],
        new CompositeExtractor(
            [new ElementExtractor()],
            ["x", "y", "name"],
            e =>
            {
                var fields = new Dictionary<string, string?> { ["name"] = e.Name };
                if (e.Location is LocationPoint lp)
                {
                    fields["x"] = UnitConverter.FormatDouble(UnitConverter.Length(lp.Point.X));
                    fields["y"] = UnitConverter.FormatDouble(UnitConverter.Length(lp.Point.Y));
                }
                return fields;
            }),
        // Required seed point (x,y) comes from the room's LocationPoint. Unplaced /
        // unenclosed rooms have no location and no boundary — skip them.
        filter: e => e.Location is LocationPoint);

    public static ITableExporter Door() => new TableExporter(
        "door",
        [BuiltInCategory.OST_Doors],
        new CompositeExtractor(
            [..CompositeExtractor.ExpandHostedElement(), new MaterializedExtractor()],
            ["width", "height", "operation", "hinge_position", "swing_side"],
            e =>
            {
                var fields = new Dictionary<string, string?>();
                var w = e.get_Parameter(BuiltInParameter.DOOR_WIDTH).AsPositiveDouble()
                     ?? e.get_Parameter(BuiltInParameter.FAMILY_WIDTH_PARAM).AsPositiveDouble()
                     ?? Extractors.ParameterUtils.FindDoubleParameterByNames(e, "width", "w", "b", "宽");
                var h = e.get_Parameter(BuiltInParameter.DOOR_HEIGHT).AsPositiveDouble()
                     ?? e.get_Parameter(BuiltInParameter.FAMILY_HEIGHT_PARAM).AsPositiveDouble()
                     ?? Extractors.ParameterUtils.FindDoubleParameterByNames(e, "height", "depth", "h", "d", "高", "深");
                fields["width"] = w is { } wv ? UnitConverter.FormatDouble(UnitConverter.Length(wv)) : null;
                fields["height"] = h is { } hv ? UnitConverter.FormatDouble(UnitConverter.Length(hv)) : null;
                fields["operation"] = GetDoorOperation(e);
                // Hinge side and swing direction from FamilyInstance flip state
                if (e is FamilyInstance fi)
                {
                    fields["hinge_position"] = fi.HandFlipped ? "end" : "start";
                    fields["swing_side"] = fi.FacingFlipped ? "right" : "left";
                }
                return fields;
            }));

    public static ITableExporter Window() => new TableExporter(
        "window",
        [BuiltInCategory.OST_Windows],
        new CompositeExtractor(
            [..CompositeExtractor.ExpandHostedElement(), new MaterializedExtractor()],
            ["width", "height", "operation"],
            e =>
            {
                var fields = new Dictionary<string, string?>();
                var w = e.get_Parameter(BuiltInParameter.WINDOW_WIDTH).AsPositiveDouble()
                     ?? e.get_Parameter(BuiltInParameter.FAMILY_WIDTH_PARAM).AsPositiveDouble()
                     ?? Extractors.ParameterUtils.FindDoubleParameterByNames(e, "width", "w", "b", "宽");
                var h = e.get_Parameter(BuiltInParameter.WINDOW_HEIGHT).AsPositiveDouble()
                     ?? e.get_Parameter(BuiltInParameter.FAMILY_HEIGHT_PARAM).AsPositiveDouble()
                     ?? Extractors.ParameterUtils.FindDoubleParameterByNames(e, "height", "depth", "h", "d", "高", "深");
                fields["width"] = w is { } wv ? UnitConverter.FormatDouble(UnitConverter.Length(wv)) : null;
                fields["height"] = h is { } hv ? UnitConverter.FormatDouble(UnitConverter.Length(hv)) : null;
                fields["operation"] = MapWindowOperation(e);
                return fields;
            }));

    /// <summary>
    /// Map Revit window family name / "Operation" parameter onto the BimDown
    /// `window.operation` enum. Family naming is the most reliable signal in
    /// practice; fall back to an explicit Operation parameter if present.
    /// </summary>
    static string? MapWindowOperation(Element e)
    {
        var explicitOp = Extractors.ParameterUtils.FindStringParameterByNames(e, "operation", "Operation", "开启方式");
        if (!string.IsNullOrWhiteSpace(explicitOp))
        {
            var normalized = NormalizeOperation(explicitOp!);
            if (normalized is not null) return normalized;
        }

        var familyName = (e as FamilyInstance)?.Symbol?.FamilyName ?? string.Empty;
        return InferOperationFromFamilyName(familyName);
    }

    static string? NormalizeOperation(string raw)
    {
        var key = raw.Trim().ToLowerInvariant().Replace('-', '_').Replace(' ', '_');
        return key switch
        {
            "fixed" or "固定" => "fixed",
            "casement" or "平开" or "外平开" or "内平开" => "casement",
            "sliding" or "推拉" => "sliding",
            "awning" or "上悬" => "awning",
            "hopper" or "下悬" => "hopper",
            "pivot" or "中悬" => "pivot",
            "double_hung" or "上下推拉" => "double_hung",
            "single_hung" => "single_hung",
            "tilt_and_turn" or "内开内倒" => "tilt_and_turn",
            _ => null,
        };
    }

    static string? InferOperationFromFamilyName(string familyName)
    {
        if (string.IsNullOrWhiteSpace(familyName)) return null;
        var name = familyName.ToLowerInvariant();
        if (name.Contains("fixed") || name.Contains("固定")) return "fixed";
        if (name.Contains("casement") || name.Contains("平开")) return "casement";
        if (name.Contains("sliding") || name.Contains("slider") || name.Contains("推拉")) return "sliding";
        if (name.Contains("awning") || name.Contains("上悬")) return "awning";
        if (name.Contains("hopper") || name.Contains("下悬")) return "hopper";
        if (name.Contains("pivot") || name.Contains("中悬")) return "pivot";
        if (name.Contains("double_hung") || name.Contains("double hung")) return "double_hung";
        if (name.Contains("single_hung") || name.Contains("single hung")) return "single_hung";
        if (name.Contains("tilt") && name.Contains("turn")) return "tilt_and_turn";
        return null;
    }

    public static ITableExporter Stair() => new TableExporter(
        "stair",
        [BuiltInCategory.OST_Stairs],
        new CompositeExtractor(
            [..CompositeExtractor.ExpandSpatialLineElement(), new VerticalSpanExtractor()],
            ["width", "step_count"],
            e =>
            {
                var fields = new Dictionary<string, string?>();
                var width = e.get_Parameter(BuiltInParameter.STAIRS_ATTR_TREAD_WIDTH).AsPositiveDouble()
                         ?? e.get_Parameter(BuiltInParameter.STAIRS_ACTUAL_TREAD_DEPTH)?.AsDouble();
                fields["width"] = width is { } w ? UnitConverter.FormatDouble(UnitConverter.Length(w)) : null;

                var steps = e.get_Parameter(BuiltInParameter.STAIRS_ACTUAL_NUM_RISERS)?.AsInteger();
                fields["step_count"] = steps?.ToString();
                return fields;
            }));

    public static ITableExporter CurtainWall() => new TableExporter(
        "curtain_wall",
        [BuiltInCategory.OST_Walls],
        new CompositeExtractor(
            [..CompositeExtractor.ExpandLineElement(), new VerticalSpanExtractor(), new MaterializedExtractor()],
            ["u_grid_count", "v_grid_count", "u_spacing", "v_spacing", "panel_count", "panel_material"],
            e =>
            {
                var fields = new Dictionary<string, string?>();
                if (e is not Wall w || w.CurtainGrid is not { } grid) return fields;

                fields["u_grid_count"] = grid.NumULines.ToString();
                fields["v_grid_count"] = grid.NumVLines.ToString();
                fields["u_spacing"] = ComputeUniformSpacing(grid.GetUGridLineIds(), e.Document);
                fields["v_spacing"] = ComputeUniformSpacing(grid.GetVGridLineIds(), e.Document);

                var panelIds = grid.GetPanelIds();
                fields["panel_count"] = panelIds.Count.ToString();
                fields["panel_material"] = GetDominantPanelMaterial(e.Document, panelIds);

                return fields;
            },
            ["panel_count"]),
        e => e is Wall w && w.WallType.Kind == WallKind.Curtain);

    static string? ComputeUniformSpacing(ICollection<ElementId> gridLineIds, Document doc)
    {
        if (gridLineIds.Count < 2) return null;

        // Get midpoints of each grid line's full curve
        var midpoints = gridLineIds
            .Select(id => doc.GetElement(id) as CurtainGridLine)
            .Where(gl => gl is not null)
            .Select(gl => gl!.FullCurve.Evaluate(0.5, true))
            .ToList();

        if (midpoints.Count < 2) return null;

        // Grid lines are parallel — project onto perpendicular direction to get 1D offsets
        // Perpendicular = direction from first to second midpoint (approximately)
        var dir = (midpoints[1] - midpoints[0]).Normalize();
        var offsets = midpoints.Select(p => dir.DotProduct(p)).OrderBy(o => o).ToList();

        var spacing = offsets[1] - offsets[0];
        for (var i = 2; i < offsets.Count; i++)
        {
            if (Math.Abs((offsets[i] - offsets[i - 1]) - spacing) > 0.001)
                return null;
        }

        return UnitConverter.FormatDouble(UnitConverter.Length(spacing));
    }

    static string? GetDominantPanelMaterial(Document doc, ICollection<ElementId> panelIds)
    {
        return panelIds
            .Select(id => doc.GetElement(id))
            .Where(p => p is not null)
            .SelectMany(p => p.GetMaterialIds(false))
            .Select(id => doc.GetElement(id) as Material)
            .Where(m => m is not null)
            .GroupBy(m => m!.Name)
            .OrderByDescending(g => g.Count())
            .FirstOrDefault()?.Key;
    }

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
                    ["width"] = width is { } w ? UnitConverter.FormatDouble(UnitConverter.Length(w)) : null
                };
            }));

    public static ITableExporter Railing() => new TableExporter(
        "railing",
        [BuiltInCategory.OST_StairsRailing],
        new CompositeExtractor(
            CompositeExtractor.ExpandSpatialLineElement(),
            ["height"],
            e =>
            {
                var height = FindDoubleParameterByNames(e, "height", "h", "高", "Top Rail Height");
                return new Dictionary<string, string?>
                {
                    ["height"] = height is { } h ? UnitConverter.FormatDouble(UnitConverter.Length(h)) : null
                };
            }));

    public static ITableExporter RoomSeparator() => new TableExporter(
        "room_separator",
        [BuiltInCategory.OST_RoomSeparationLines],
        new CompositeExtractor(CompositeExtractor.ExpandLineElement()));

    static string? GetDoorOperation(Element e)
    {
        var op = Extractors.ParameterUtils.FindStringParameterByNames(e, "Operation", "Swing", "操作", "开启");
        if (!string.IsNullOrEmpty(op))
        {
            var lowerOp = op.ToLowerInvariant();
            if (lowerOp.Contains("single") || lowerOp.Contains("单开") || lowerOp.Contains("单扇") || lowerOp.Contains("单门")) return "single_swing";
            if (lowerOp.Contains("double") || lowerOp.Contains("双开") || lowerOp.Contains("双扇") || lowerOp.Contains("双门")) return "double_swing";
            if (lowerOp.Contains("sliding") || lowerOp.Contains("推拉")) return "sliding";
            if (lowerOp.Contains("folding") || lowerOp.Contains("折叠")) return "folding";
            if (lowerOp.Contains("revolving") || lowerOp.Contains("旋转")) return "revolving";
            return op;
        }

        var name = (e.Name + " " + (e as FamilyInstance)?.Symbol.Family.Name).ToLowerInvariant();
        if (name.Contains("single") || name.Contains("单开") || name.Contains("单扇") || name.Contains("单门")) return "single_swing";
        if (name.Contains("double") || name.Contains("双开") || name.Contains("双扇") || name.Contains("双门")) return "double_swing";
        if (name.Contains("sliding") || name.Contains("推拉")) return "sliding";
        if (name.Contains("folding") || name.Contains("折叠")) return "folding";
        if (name.Contains("revolving") || name.Contains("旋转")) return "revolving";

        return null;
    }
}
