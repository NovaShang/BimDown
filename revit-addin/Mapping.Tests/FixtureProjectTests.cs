using System.Diagnostics;
using System.Globalization;
using BimDown.RevitAddin.Mapping;
using Xunit;
using Xunit.Abstractions;

namespace BimDown.RevitAddin.Tests;

/// <summary>
/// Builds the rows the Revit exporters produce for a small two-storey building
/// (through the same mappers and ProjectWriter the add-in uses), writes the
/// project and — when BIMDOWN_CLI points at cli/dist/cli.js — runs
/// `bimdown validate` on it. BIMDOWN_FIXTURE_DIR keeps the project for inspection.
/// </summary>
public class FixtureProjectTests(ITestOutputHelper output)
{
    static readonly string[] Element = ["id", "number", "mesh_file", "group_id", "pinned"];

    static Dictionary<string, string?> R(params (string Key, object? Value)[] kv) =>
        kv.ToDictionary(p => p.Key, p => p.Value switch
        {
            null => null,
            double d => Names.Num(d, 4),
            int i => i.ToString(CultureInfo.InvariantCulture),
            _ => p.Value.ToString(),
        });

    static Dictionary<string, string?> With(Dictionary<string, string?> row, Dictionary<string, string?> extra)
    {
        foreach (var (k, v) in extra) row[k] = v;
        return row;
    }

    static string Poly(IEnumerable<(double X, double Y)> pts) =>
        "[" + string.Join(",", pts.Select(p => $"[{Names.Num(p.X, 4)},{Names.Num(p.Y, 4)}]")) + "]";

    static Dictionary<string, string?> Line(Dictionary<string, string?> row, double x0, double y0, double x1, double y1, double? z0 = null, double? z1 = null)
    {
        row["start_x"] = Names.Num(x0, 4); row["start_y"] = Names.Num(y0, 4);
        row["end_x"] = Names.Num(x1, 4); row["end_y"] = Names.Num(y1, 4);
        if (z0 is not null) { row["start_z"] = Names.Num(z0.Value, 4); row["end_z"] = Names.Num(z1!.Value, 4); }
        return row;
    }

    internal static List<ExportedTable> BuildTables()
    {
        var t = new List<ExportedTable>();
        void Add(string name, bool global, string[] cols, params Dictionary<string, string?>[] rows) =>
            t.Add(new ExportedTable(name, global, cols, rows.ToList()));

        // ── Levels and grids ──
        Add("level", true, ["id", "number", "name", "elevation"],
            R(("id", "L1"), ("number", "1"), ("name", "Level 1"), ("elevation", 0.0)),
            R(("id", "L2"), ("number", "2"), ("name", "Level 2"), ("elevation", 3.5)),
            R(("id", "L3"), ("number", "3"), ("name", "Level 3"), ("elevation", 7.0)));
        Add("grid", true, ["id", "number", "start_x", "start_y", "end_x", "end_y", "pinned"],
            R(("id", "G1"), ("number", "A"), ("start_x", 0.0), ("start_y", -2.0), ("end_x", 0.0), ("end_y", 10.0), ("pinned", "true")));

        // ── Wall type with layers (Revit compound structure, exterior first) ──
        LayerInput[] etics =
        [
            new("Finish1", "Render", 0.01, 0.7), new("Insulation", "EPS 100", 0.1, 0.035),
            new("Membrane", "Vapour barrier", 0), new("Structure", "Concrete C30/37", 0.2, 2.3, IsCore: true),
            new("Finish2", "Gypsum plaster", 0.015),
        ];
        var wallType = LayerMapper.TypeRow("WT1", "Exterior - Concrete 200 + EPS 100", etics);
        LayerInput[] floorBuildUp = [new("Finish1", "Ceramic tile", 0.01), new("Substrate", "Screed", 0.05), new("Structure", "Concrete", 0.2, IsCore: true)];
        var slabType = LayerMapper.TypeRow("ST1", "Floor 260", floorBuildUp);
        var roofType = LayerMapper.TypeRow("RT1", "Roof - Timber", [new("Finish1", "Clay tile", 0.03), new("Insulation", "Mineral wool", 0.2), new("Structure", "Wood", 0.05, IsCore: true)]);
        var unusedType = LayerMapper.TypeRow("WT-unused", "Never placed", [new("Structure", "Brick", 0.1)]);
        Add("wall_type", true, ["id", "name", "description", "material", "thickness"], wallType, unusedType);
        Add("slab_type", true, ["id", "name", "description", "material", "thickness", "material_grade"], slabType);
        Add("roof_type", true, ["id", "name", "description", "material", "thickness"], roofType);
        Add("type_layer", true, ["id", "type_id", "seq", "function", "material", "thickness", "conductivity", "name"],
            [.. LayerMapper.LayerRows("WT1", etics), .. LayerMapper.LayerRows("ST1", floorBuildUp),
             .. LayerMapper.LayerRows("RT1", [new("Finish1", "Clay tile", 0.03), new("Insulation", "Mineral wool", 0.2), new("Structure", "Wood", 0.05)]),
             .. LayerMapper.LayerRows("WT-unused", [new("Structure", "Brick", 0.1)])]);

        // ── Walls: a 10 x 8 box drawn clockwise; w4 comes from Revit reversed ──
        string[] wallCols = [.. Element, "base_level_id", "top_level_id", "material", "type_id", "thickness", "top_attach_id"];
        (string Id, double X0, double Y0, double X1, double Y1)[] box = [("W1", 0, 0, 0, 8), ("W2", 0, 8, 10, 8), ("W3", 10, 8, 10, 0), ("W4", 10, 0, 0, 0)];
        var walls = new List<Dictionary<string, string?>>();
        foreach (var (id, x0, y0, x1, y1) in box)
        {
            var row = Line(R(("id", id), ("level_id", "L1"), ("base_level_id", "L1"), ("top_level_id", "L2"),
                ("thickness", 0.325), ("material", "concrete"), ("type_id", "WT1"), ("top_attach_id", id == "W1" ? "ROOF1" : null)), x0, y0, x1, y1);
            row["_svg_d"] = $"M {row["start_x"]},{row["start_y"]} L {row["end_x"]},{row["end_y"]}";
            walls.Add(row);
        }
        Add("wall", false, wallCols, [.. walls]);

        // Walls in BimDown orientation for the boundary match
        var wallLines = box.Select(b => new WallLine(b.Id, b.X0, b.Y0, b.X1, b.Y1, 0.325, 0.0575, -0.1425)).ToList();

        // ── Slab picked at the core faces, roof with a 0.5 m overhang at the exterior face ──
        (double, double)[] slabPoly = [(0.1425, 0.1425), (9.8575, 0.1425), (9.8575, 7.8575), (0.1425, 7.8575)];
        var slab = R(("id", "SL1"), ("level_id", "L1"), ("function", "floor"), ("thickness", 0.26), ("material", "concrete"), ("type_id", "ST1"));
        slab["points"] = Poly(slabPoly);
        WallMapper.Apply(slab, WallMapper.MatchBoundary(slabPoly, wallLines, "core")!, "core");
        Add("slab", false, [.. Element, "material", "type_id", "function", "thickness", "boundary_walls", "boundary_face", "boundary_offset"], slab);

        (double, double)[] roofPoly = [(-0.6625, -0.6625), (10.6625, -0.6625), (10.6625, 8.6625), (-0.6625, 8.6625)];
        var shape = RoofMapper.Classify([30, null, 30, null]);
        var roof = R(("id", "ROOF1"), ("level_id", "L1"), ("base_offset", 3.5), ("roof_type", shape.RoofType), ("slope", shape.Slope), ("edge_slopes", shape.EdgeSlopes),
            ("thickness", 0.28), ("type_id", "RT1"), ("material", "wood"));
        roof["points"] = Poly(roofPoly);
        WallMapper.Apply(roof, WallMapper.MatchBoundary(roofPoly, wallLines, "exterior")!, "exterior");
        Assert.Equal("0.5", roof["boundary_offset"]);
        var ext = RoofMapper.Extrusion([(0, 3.2), (2, 4.2), (4, 3.2)], 0.2, (12, 0), (1, 0), (0, 1), 0, 6);
        var roof2 = R(("id", "ROOF2"), ("level_id", "L2"), ("roof_type", "extrusion"), ("profile", ext.Profile), ("thickness", 0.2), ("base_offset", ext.BaseOffset));
        roof2["points"] = Poly(ext.Footprint);
        Add("roof", false, [.. Element, "material", "type_id", "roof_type", "slope", "edge_slopes", "profile", "thickness", "boundary_walls", "boundary_face", "boundary_offset"], roof, roof2);

        // ── Doors / windows with types ──
        var fen = new[] { "id", "name", "description", "material", "width", "height", "operation", "frame_width", "u_value", "shgc", "vt" };
        Add("door_type", true, fen,
            R(("id", "DT1"), ("name", "Single-Flush 900 x 2100"), ("material", "wood"), ("width", 0.9), ("height", 2.1),
              ("operation", OpeningMapper.DoorOperation(null, "M_Single-Flush", "0915 x 2134mm")), ("u_value", 1.8)));
        Add("window_type", true, fen,
            R(("id", "WNT1"), ("name", "Casement 1200 x 1500"), ("material", "aluminum"), ("width", 1.2), ("height", 1.5),
              ("operation", OpeningMapper.WindowOperation(null, "M_Window-Casement", "")), ("u_value", 1.3), ("shgc", 0.45), ("vt", 0.6)));
        var door = R(("id", "D1"), ("number", "D101"), ("level_id", "L1"), ("host_id", "W4"), ("position", 1.5), ("width", 0.9), ("height", 2.1),
            ("type_id", "DT1"), ("hinge_position", "start"), ("swing_side", "left"), ("material", "wood"));
        WallMapper.ReverseHosted(door, 10); // W4 was reversed by the exporter
        Add("door", false, [.. Element, "host_id", "position", "base_offset", "material", "type_id", "width", "height", "operation", "hinge_position", "swing_side"], door);
        Add("window", false, [.. Element, "host_id", "position", "base_offset", "material", "type_id", "width", "height", "operation"],
            R(("id", "WN1"), ("number", "W101"), ("level_id", "L1"), ("host_id", "W2"), ("position", 5.0), ("base_offset", 0.9), ("type_id", "WNT1"), ("width", 1.2), ("height", 1.5)));

        // ── Openings: a wall opening and a shaft through both floors ──
        var shaft = R(("id", "SH1"), ("level_id", "L1"), ("top_level_id", "L3"), ("_keep_level", "true"), ("base_offset", null));
        shaft["points"] = Poly([(6, 5), (7, 5), (7, 6), (6, 6)]);
        Add("opening", false, [.. Element, "host_id", "position", "width", "height", "shape", "base_offset", "top_level_id", "top_offset"],
            R(("id", "OP1"), ("level_id", "L1"), ("host_id", "W3"), ("position", 2.0), ("width", 1.0), ("height", 1.0), ("shape", "rect"), ("base_offset", 1.0)),
            shaft);

        // ── Curtain wall with explicit grid, panels and door numbers ──
        Add("curtain_wall_type", true, ["id", "name", "material", "u_spacing", "v_spacing", "panel_material", "mullion_width", "mullion_depth", "mullion_profile"],
            R(("id", "CWT1"), ("name", "Storefront"), ("material", "aluminum"), ("v_spacing", 1.5), ("panel_material", "glass"), ("mullion_width", 0.05), ("mullion_depth", 0.15), ("mullion_profile", "rect")));
        var grid = CurtainGridMapper.Map(6, 3.5, [1.5, 3, 4.5], [0.9],
            [new(0.75, 0.45, "solid"), new(2.25, 0.45, "solid"), new(3.75, 0.45, "door", "D102"), new(5.25, 0.45, "solid")]);
        var cw = Line(With(R(("id", "CW1"), ("level_id", "L1"), ("base_level_id", "L1"), ("top_level_id", "L2"), ("type_id", "CWT1"), ("material", "aluminum")), grid), 2, -3, 8, -3);
        Add("curtain_wall", false, [.. Element, "base_level_id", "top_level_id", "material", "type_id", "u_grid_count", "v_grid_count", "u_grids", "v_grids", "panels", "door_numbers", "u_spacing", "v_spacing", "panel_material"], cw);

        // ── Stair: two runs (U), one landing, railings on both sides; repeats up to L3 ──
        var runs = StairMapper.Order(
        [
            new StairRunInput("RUN2", 3.0, 3.3, 1.75, 0.3, 3.3, 3.5, 1.1, 10),
            new StairRunInput("RUN1", 0.3, 2.0, 0.0, 3.0, 2.0, 1.75, 1.1, 10),
        ]);
        var stair = Line(R(("id", "STAIR1"), ("level_id", "L1"), ("base_level_id", "L1"), ("top_level_id", "L2"), ("width", runs[0].Width), ("step_count", runs[0].Risers),
            ("stair_type", StairMapper.Classify(runs)), ("multistory_top_level_id", "L3"), ("material", "concrete")), runs[0].X0, runs[0].Y0, runs[0].X1, runs[0].Y1, runs[0].Z0, runs[0].Z1);
        Add("stair", false, [.. Element, "base_level_id", "top_level_id", "material", "width", "step_count", "stair_type", "multistory_top_level_id"], stair);
        var run2 = StairMapper.RunRow(runs[1], "STAIR1");
        run2["level_id"] = "L1"; run2["top_level_id"] = "L2";
        Add("stair_run", false, ["id", "number", "host_id", "width", "step_count", "material"], run2);
        var landing = R(("id", "LAND1"), ("host_id", "STAIR1"), ("base_offset", 1.75), ("thickness", 0.2), ("level_id", "L1"), ("top_level_id", "L2"));
        landing["points"] = Poly([(3.0, 1.45), (4.1, 1.45), (4.1, 3.85), (3.0, 3.85)]);
        Add("stair_landing", false, ["id", "number", "host_id", "base_offset", "thickness", "material"], landing);
        Add("railing_type", true, ["id", "name", "description", "material", "height", "top_rail_shape", "top_rail_size", "infill", "baluster_spacing", "baluster_size"],
            With(R(("id", "RLT1")), RailingMapper.TypeFields(new RailingTypeInput("Handrail - Pipe 1000", 1.0, "Circular Handrail : 50mm", 0.05, ["Baluster - Square : 25mm"], 0.12, 0.025, "Steel"))));
        var rl1 = R(("id", "RL1"), ("host_id", "STAIR1"), ("side", StairMapper.RailingSide(runs[0], 1.5, 1.4)), ("type_id", "RLT1"), ("level_id", "L1"), ("top_level_id", "L2"));
        var rl2 = R(("id", "RL2"), ("host_id", "STAIR1"), ("side", StairMapper.RailingSide(runs[0], 1.5, 2.6)), ("type_id", "RLT1"), ("level_id", "L1"), ("top_level_id", "L2"));
        var rl3 = Line(R(("id", "RL3"), ("type_id", "RLT1"), ("level_id", "L2")), 0, -1, 4, -1, 3.5, 3.5);
        rl3["_path"] = "[[0,-1,3.5],[2,-1.5,3.5],[4,-1,3.5]]";
        Add("railing", false, [.. Element, "material", "type_id", "height", "host_id", "side", "baluster_spacing"], rl1, rl2, rl3);

        // ── Spaces and furniture in a model group ──
        Add("space", false, [.. Element, "x", "y", "name"], R(("id", "ROOM1"), ("number", "101"), ("level_id", "L1"), ("x", 5.0), ("y", 6.0), ("name", "Bedroom")));
        var bed = FurnitureMapper.Guess("M_Bed-Standard", "Queen");
        Add("furniture_type", true, ["id", "name", "description", "family", "variant", "size_x", "size_y", "height"],
            R(("id", "FT1"), ("name", "Bed Queen"), ("family", bed.Family), ("variant", bed.Variant), ("size_x", 1.6), ("size_y", 2.1), ("height", 0.95)),
            R(("id", "FT2"), ("name", "Mystery box"), ("family", FurnitureMapper.Guess("Embedded Box", "A").Family), ("size_x", 0.8), ("size_y", 0.4), ("height", 0.5)));
        var (bx, by) = FurnitureMapper.FootprintCenter(7, 6, 0, -0.8, 0.8, 0, 2.1);
        Add("furniture", false, [.. Element, "type_id", "family", "variant", "size_x", "size_y", "height", "mirror"],
            R(("id", "FU1"), ("level_id", "L1"), ("x", bx), ("y", by), ("type_id", "FT1"), ("family", "bed"), ("variant", "double"), ("size_x", 1.6), ("group_id", "GRP1")),
            R(("id", "FU2"), ("level_id", "L1"), ("x", 2.0), ("y", 6.5), ("rotation", 90.0), ("type_id", "FT2"), ("family", "generic_box"), ("mirror", "true"), ("group_id", "GRP1")));
        Add("model_group", false, ["id", "name", "x", "y", "rotation", "mirrored"],
            R(("id", "GRP1"), ("level_id", "L1"), ("name", "Bedroom set"), ("x", 2.0), ("y", 6.0)),
            R(("id", "GRP-empty"), ("level_id", "L1"), ("name", "Empty"), ("x", 0.0), ("y", 0.0)));

        // ── Structure: columns, beams, beam system, foundations ──
        string[] section = [ "id", "name", "description", "material", "shape", "size_x", "size_y", "flange", "web", "thickness", "root_radius", "designation", "material_grade"];
        var w14 = SectionMapper.Map(new SectionInput { ShapeName = "IWideFlange", FamilyName = "W Shapes", TypeName = "W14X90", Width = 0.369, Height = 0.356, FlangeThickness = 0.018, WebThickness = 0.0112, WebFillet = 0.0157 });
        var hea = SectionMapper.Map(new SectionInput { FamilyName = "UB-Universal Beams", TypeName = "HEA 300", Params = new Dictionary<string, double> { ["b"] = 0.3, ["h"] = 0.29, ["tf"] = 0.014, ["tw"] = 0.0085, ["r"] = 0.027 } });
        var joist = SectionMapper.Map(new SectionInput { FamilyName = "K-Series Bar Joist-Rod Web", TypeName = "14K1", Params = new Dictionary<string, double> { ["b"] = 0.1, ["d"] = 0.356 } });
        Add("column_type", true, section, With(R(("id", "CT1"), ("name", "W14X90"), ("material", "steel"), ("material_grade", MaterialMapper.MaterialGrade("Steel ASTM A992"))), w14));
        Add("beam_type", true, section,
            With(R(("id", "BT1"), ("name", "HEA 300"), ("material", "steel"), ("material_grade", "S355")), hea),
            With(R(("id", "BT2"), ("name", "14K1"), ("material", "steel")), joist));
        Add("structure_column", false, [.. Element, "base_level_id", "top_level_id", "material", "type_id", .. section[4..]],
            With(R(("id", "SC1"), ("level_id", "L1"), ("base_level_id", "L1"), ("top_level_id", "L2"), ("x", 0.0), ("y", 0.0), ("type_id", "CT1"), ("material", "steel")), w14),
            With(R(("id", "SC2"), ("level_id", "L1"), ("base_level_id", "L1"), ("top_level_id", "L2"), ("x", 10.0), ("y", 0.0), ("type_id", "CT1"), ("material", "steel"), ("material_grade", "S355")), w14));
        Add("beam", false, [.. Element, "material", "type_id", .. section[4..], "beam_system_id"],
            With(Line(R(("id", "BM1"), ("level_id", "L2"), ("type_id", "BT1"), ("material", "steel")), 0, 0, 10, 0, 3.5, 3.5), hea),
            With(Line(R(("id", "BM2"), ("level_id", "L2"), ("type_id", "BT2"), ("material", "steel"), ("beam_system_id", "BS1")), 0, 4, 10, 4, 3.5, 3.5), joist));
        var bsys = R(("id", "BS1"), ("level_id", "L2"), ("spacing", 2.0), ("direction", 0.0), ("type_id", "BT2"));
        bsys["points"] = Poly([(0, 0), (10, 0), (10, 8), (0, 8)]);
        Add("beam_system", false, ["id", "number", "spacing", "direction", "type_id", "material_grade"], bsys);
        Add("foundation_type", true, ["id", "name", "material", "kind", "width", "length", "thickness", "material_grade"],
            R(("id", "FDT1"), ("name", "Pad 2000 x 2000 x 600"), ("material", "concrete"), ("kind", FoundationMapper.Kind("FamilyInstance", "M_Footing-Rectangular", "2000x2000x600mm")), ("width", 2.0), ("length", 2.0), ("thickness", 0.6), ("material_grade", "C30")),
            R(("id", "FDT2"), ("name", "Bored pile 600"), ("material", "concrete"), ("kind", FoundationMapper.Kind("FamilyInstance", "Pile-Concrete Round", "600")), ("width", 0.6), ("thickness", 15.0)));
        var pileCap = R(("id", "F3"), ("level_id", "L1"), ("kind", "pile_cap"), ("thickness", 0.8), ("material", "concrete"));
        pileCap["points"] = Poly(FoundationMapper.RectFootprint(5, -6, 2.4, 1.2, 30));
        Add("foundation", false, [.. Element, "material", "type_id", "kind", "thickness", "width", "length", "material_grade"],
            R(("id", "F1"), ("level_id", "L1"), ("x", 0.0), ("y", 0.0), ("type_id", "FDT1"), ("kind", "pad"), ("width", 2.0), ("base_offset", -1.2)),
            R(("id", "F2"), ("level_id", "L1"), ("x", 5.0), ("y", -6.0), ("type_id", "FDT2"), ("kind", "pile")),
            pileCap,
            Line(R(("id", "F4"), ("level_id", "L1"), ("kind", "strip"), ("width", 0.8), ("thickness", 0.4), ("material", "concrete")), 0, 0, 0, 8));

        // ── MEP ──
        Add("mep_system", true, ["id", "system_type", "name", "color", "discipline"],
            R(("id", "SYS-SA"), ("system_type", MepMapper.SystemTag(null, "SupplyAir", "Supply Air")), ("name", "Supply Air"), ("color", MepMapper.ColorHex(47, 125, 246)), ("discipline", MepMapper.Discipline("SupplyAir"))),
            R(("id", "SYS-DCW"), ("system_type", MepMapper.SystemTag(null, "DomesticColdWater", "Domestic Cold Water")), ("name", "Domestic Cold Water"), ("discipline", "plumbing")));
        string[] mepPoint = [.. Element, "system_type"];
        Add("equipment", false, [.. mepPoint, "equipment_type", "family", "type", "flow", "load", "circuit_id"],
            R(("id", "AHU1"), ("level_id", "L1"), ("x", 8.0), ("y", 1.0), ("base_offset", 0.0), ("system_type", "SA"), ("equipment_type", MepMapper.EquipmentType("air handling unit")), ("family", "AHU"), ("type", "5000 L/s"), ("flow", 5000.0), ("load", 7500.0)),
            R(("id", "PNL1"), ("level_id", "L1"), ("x", 9.5), ("y", 7.5), ("equipment_type", MepMapper.EquipmentType("lighting panelboard")), ("family", "Panelboard"), ("type", "LP-1")));
        Add("terminal", false, [.. mepPoint, "terminal_type", "family", "type", "flow", "load", "circuit_id"],
            R(("id", "DIF1"), ("level_id", "L1"), ("x", 5.0), ("y", 4.0), ("base_offset", 2.7), ("system_type", "SA"), ("terminal_type", MepMapper.TerminalType("OST_DuctTerminal", "supply diffuser")), ("flow", 150.0)),
            R(("id", "LT1"), ("level_id", "L1"), ("x", 3.0), ("y", 4.0), ("base_offset", 2.7), ("terminal_type", MepMapper.TerminalType("OST_LightingFixtures", "troffer")), ("load", MepMapper.LoadWatts(40, 0.9)), ("circuit_id", "CIR1")),
            R(("id", "WC1"), ("level_id", "L1"), ("x", 1.0), ("y", 7.0), ("system_type", "DCW"), ("terminal_type", MepMapper.TerminalType("OST_PlumbingFixtures", "toilet"))));
        Add("circuit", false, ["id", "number", "host_id", "name", "voltage", "poles", "rating"],
            R(("id", "CIR1"), ("number", "1"), ("host_id", "PNL1"), ("name", "Lighting"), ("voltage", 230.0), ("poles", 1), ("rating", 16.0), ("level_id", "L1")));
        Add("mep_node", false, [.. mepPoint, "kind", "fitting", "family", "type", "shape", "size_w", "size_h"],
            R(("id", "ELB1"), ("level_id", "L1"), ("x", 8.0), ("y", 4.0), ("base_offset", 1.9), ("system_type", "SA"), ("fitting", MepMapper.Fitting("Elbow")), ("family", "Rectangular Elbow")),
            R(("id", "VLV1"), ("level_id", "L1"), ("x", 1.0), ("y", 5.0), ("base_offset", 0.3), ("system_type", "DCW"), ("kind", MepMapper.AccessoryKind("Gate Valve", "25mm")), ("shape", "round"), ("size_w", 0.025)));
        Add("connector", false, ["id", "host_id", "name", "offset_x", "offset_y", "offset_z", "dir_x", "dir_y", "dir_z", "shape", "size_w", "size_h", "system_type", "flow_dir", "domain"],
            R(("id", "AHU1.c0"), ("host_id", "AHU1"), ("name", Names.PortSlug("Supply Air")), ("offset_x", 0.0), ("offset_y", 0.5), ("offset_z", 1.9), ("dir_x", 0.0), ("dir_y", 0.0), ("dir_z", 1.0),
              ("shape", "rect"), ("size_w", 0.6), ("size_h", 0.4), ("system_type", "SA"), ("flow_dir", "out"), ("domain", "hvac"), ("level_id", "L1")),
            R(("id", "VLV1.c0"), ("host_id", "VLV1"), ("name", "in"), ("dir_x", 0.0), ("dir_y", -1.0), ("dir_z", 0.0), ("shape", "round"), ("size_w", 0.025), ("system_type", "DCW"), ("flow_dir", "in"), ("domain", "piping"), ("level_id", "L1")),
            R(("id", "VLV1.c1"), ("host_id", "VLV1"), ("name", "out"), ("dir_x", 0.0), ("dir_y", 1.0), ("dir_z", 0.0), ("shape", "round"), ("size_w", 0.025), ("system_type", "DCW"), ("flow_dir", "out"), ("domain", "piping"), ("level_id", "L1")));
        string[] curve = [.. Element, "shape", "size_x", "size_y", "system_type", "from", "to"];
        Add("duct", false, [.. curve, "insulation_thickness", "flexible"],
            Line(R(("id", "DU1"), ("level_id", "L1"), ("shape", "rect"), ("size_x", 0.6), ("size_y", 0.4), ("system_type", "SA"), ("from", "AHU1:supply_air"), ("to", "ELB1"), ("insulation_thickness", 0.025)), 8, 1.5, 8, 4, 1.9, 1.9),
            Line(R(("id", "DU2"), ("level_id", "L1"), ("shape", "round"), ("size_x", 0.25), ("system_type", "SA"), ("from", "ELB1"), ("flexible", "true")), 8, 4, 5, 4, 1.9, 1.9));
        Add("pipe", false, [.. curve, "insulation_thickness", "material"],
            Line(R(("id", "PI1"), ("level_id", "L1"), ("shape", "round"), ("size_x", 0.025), ("system_type", "DCW"), ("to", "VLV1:in"), ("material", MaterialMapper.PipeMaterial("Copper"))), 1, 3, 1, 5, 0.3, 0.3));

        // ── Plan annotations on level 1 ──
        Add("text_note", false, ["id", "x", "y", "text", "paper_size", "rotation"],
            R(("id", "TX1"), ("level_id", "L1"), ("x", 5.0), ("y", -1.5), ("text", "SOUTH ELEVATION\\nsee A-201"), ("paper_size", AnnotationMapper.PaperSizeMm(0.0025))));
        Add("tag", false, ["id", "host_id", "x", "y", "content"],
            R(("id", "TG1"), ("level_id", "L1"), ("host_id", "D1"), ("x", 8.0), ("y", -0.8)),
            R(("id", "TG2"), ("level_id", "L1"), ("host_id", "ROOM1")));
        var dims = AnnotationMapper.DimensionRows("DIM1", 1, 0, [new(2.5, -1, 5), new(7.5, -1, 5)]);
        foreach (var d in dims) d["level_id"] = "L1";
        Add("dimension", false, ["id", "start_x", "start_y", "end_x", "end_y", "start_ref", "end_ref", "direction", "offset", "text"], [.. dims]);
        return t;
    }

    static string FixtureDir() =>
        Environment.GetEnvironmentVariable("BIMDOWN_FIXTURE_DIR") is { Length: > 0 } d
            ? d
            : Path.Combine(Path.GetTempPath(), $"bimdown-revit-fixture-{Guid.NewGuid():N}");

    [Fact]
    public void WritesAValidProject()
    {
        var dir = FixtureDir();
        if (Directory.Exists(dir)) Directory.Delete(dir, true);
        var tables = BuildTables();
        var idGen = new ShortIdGenerator();
        ProjectWriter.WriteProject(dir, tables, idGen, "Revit fixture", "Revit 2026 (mapping fixture)");

        // Types: the unused wall type and its layer are dropped, inherited values blanked.
        var wallTypes = File.ReadAllText(Path.Combine(dir, "global", "wall_type.csv"));
        Assert.Contains("wt-exterior-concrete-200-eps-100", wallTypes);
        Assert.DoesNotContain("never-placed", wallTypes);
        var wallCsv = File.ReadAllLines(Path.Combine(dir, "lv-1", "wall.csv"));
        Assert.Contains("type_id", wallCsv[0]);
        Assert.Contains("top_attach_id", wallCsv[0]);
        Assert.Contains("ro-1", wallCsv[1]);
        // The empty model group is gone; the shaft stays on level 1.
        Assert.Single(File.ReadAllLines(Path.Combine(dir, "lv-1", "model_group.csv")).Skip(1));
        Assert.Contains("lv-3", File.ReadAllText(Path.Combine(dir, "lv-1", "opening.csv")));
        // The slab is associated with its walls.
        Assert.Contains("w-4;w-3;w-2;w-1", File.ReadAllText(Path.Combine(dir, "lv-1", "slab.csv")));
        // Railing path keeps every vertex.
        Assert.Contains("[2,-1.5,3.5]", File.ReadAllText(Path.Combine(dir, "lv-2", "railing.geojson")));
        Assert.Contains("w-4;w-3;w-2;w-1", File.ReadAllText(Path.Combine(dir, "lv-1", "roof.csv")));

        var cli = Environment.GetEnvironmentVariable("BIMDOWN_CLI");
        if (string.IsNullOrEmpty(cli) || !File.Exists(cli))
        {
            output.WriteLine("BIMDOWN_CLI not set: skipped `bimdown validate`.");
            return;
        }
        var psi = new ProcessStartInfo("node", [cli, "validate", dir])
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        using var p = Process.Start(psi)!;
        var stdout = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd();
        p.WaitForExit();
        output.WriteLine(stdout);
        Assert.True(p.ExitCode == 0, $"bimdown validate failed:\n{stdout}");
    }
}
