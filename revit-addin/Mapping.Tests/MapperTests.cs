using BimDown.RevitAddin.Mapping;
using Xunit;

namespace BimDown.RevitAddin.Tests;

public class MaterialMapperTests
{
    [Theory]
    [InlineData("Concrete, Cast-in-Place gray", "concrete")]
    [InlineData("C30 混凝土", "concrete")]
    [InlineData("Metal - Aluminum", "aluminum")]
    [InlineData("Steel, 345 MPa", "steel")]
    [InlineData("Insulation / Thermal Barriers - Rigid insulation", "insulation")]
    [InlineData("Glass wool", "insulation")]
    [InlineData("Glass", "glass")]
    [InlineData("Masonry - Brick", "brick")]
    [InlineData("Gypsum Wall Board", "gypsum")]
    [InlineData("Wood - Dimensional Lumber", "wood")]
    [InlineData("CLT panel", "clt")]
    [InlineData("Ceramic tile", "ceramic")]
    [InlineData(null, "composite")]
    [InlineData("Default", "composite")]
    public void MapsMaterialNames(string? name, string expected) => Assert.Equal(expected, MaterialMapper.MapToEnum(name));

    [Theory]
    [InlineData("Copper", "copper")]
    [InlineData("Stainless Steel", "stainless_steel")]
    [InlineData("Steel, Carbon", "steel")]
    [InlineData("Galvanized Steel", "galvanized_steel")]
    [InlineData("PVC - Rigid", "pvc")]
    [InlineData("PP-R", "ppr")]
    [InlineData("HDPE", "hdpe")]
    [InlineData("PEX", "pex")]
    [InlineData("Cast Iron", "cast_iron")]
    [InlineData("Ductile Iron", "ductile_iron")]
    [InlineData("Unobtainium", null)]
    public void MapsPipeMaterials(string name, string? expected) => Assert.Equal(expected, MaterialMapper.PipeMaterial(name));

    [Theory]
    [InlineData("Concrete, C30/37", "C30/37")]
    [InlineData("Steel ASTM A992", "A992")]
    [InlineData("Q355B 钢", "Q355B")]
    [InlineData("Steel S355JR", "S355JR")]
    [InlineData("Glulam GL24h", "GL24h")]
    [InlineData("C30 混凝土", "C30")]
    [InlineData("Concrete - Cast-in-Place Concrete", null)]
    public void ParsesGrades(string name, string? expected) => Assert.Equal(expected, MaterialMapper.MaterialGrade(name));
}

public class LayerMapperTests
{
    static readonly LayerInput[] Etics =
    [
        new("Finish1", "Render", 0.01, 0.7),
        new("Insulation", "EPS 100", 0.1, 0.035),
        new("Membrane", "Vapour barrier", 0),
        new("Structure", "Concrete C30/37", 0.2, 2.3, IsCore: true),
        new("Finish2", "Gypsum plaster", 0.015),
    ];

    [Fact]
    public void LayersKeepRevitOrderAndDropZeroWidth()
    {
        var rows = LayerMapper.LayerRows("T", Etics);
        Assert.Equal(4, rows.Count);
        Assert.Equal(["1", "2", "3", "4"], rows.Select(r => r["seq"]));
        Assert.Equal(["finish", "insulation", "core", "finish"], rows.Select(r => r["function"]));
        Assert.Equal("insulation", rows[1]["material"]);
        Assert.Equal("0.035", rows[1]["conductivity"]);
        Assert.Equal("T", rows[0]["type_id"]);
    }

    [Fact]
    public void TypeRowThicknessIsLayerSum()
    {
        var row = LayerMapper.TypeRow("T", "ETICS", Etics);
        Assert.Equal("0.325", row["thickness"]);
        Assert.Equal("concrete", row["material"]);
    }

    [Fact]
    public void AirLayerIsAirGap() => Assert.Equal("air_gap", LayerMapper.Function("Finish1", "Air Space"));
}

public class SectionMapperTests
{
    [Fact]
    public void WideFlangeFromSectionApi()
    {
        var f = SectionMapper.Map(new SectionInput
        {
            ShapeName = "IWideFlange", FamilyName = "W Shapes", TypeName = "W14X90",
            Width = 0.369, Height = 0.356, FlangeThickness = 0.018, WebThickness = 0.0112, WebFillet = 0.0157,
        });
        Assert.Equal("i_shape", f["shape"]);
        Assert.Equal("0.369", f["size_x"]);
        Assert.Equal("0.356", f["size_y"]);
        Assert.Equal("0.018", f["flange"]);
        Assert.Equal("0.0112", f["web"]);
        Assert.Equal("0.0157", f["root_radius"]);
        Assert.Equal("W14X90", f["designation"]);
    }

    [Fact]
    public void HollowSectionsFromNamesAndParams()
    {
        var rhs = SectionMapper.Map(new SectionInput
        {
            FamilyName = "HSS-Hollow Structural Section", TypeName = "HSS8X8X1/2",
            Params = new Dictionary<string, double> { ["b"] = 0.2032, ["ht"] = 0.2032, ["tdes"] = 0.0118 },
        });
        Assert.Equal("rect_hollow", rhs["shape"]);
        Assert.Equal("0.0118", rhs["thickness"]);
        Assert.Equal("HSS8X8X1/2", rhs["designation"]);

        var chs = SectionMapper.Map(new SectionInput { ShapeName = "PipeStandard", TypeName = "CHS 219.1x8", Diameter = 0.2191, WallThickness = 0.008 });
        Assert.Equal("round_hollow", chs["shape"]);
        Assert.Equal("0.2191", chs["size_x"]);
        Assert.Equal("0.008", chs["thickness"]);
    }

    [Fact]
    public void ConcreteAndEuroNames()
    {
        var conc = SectionMapper.Map(new SectionInput
        {
            FamilyName = "Concrete-Rectangular-Column", TypeName = "300 x 450mm",
            Params = new Dictionary<string, double> { ["b"] = 0.3, ["h"] = 0.45 },
        });
        Assert.Equal("rect", conc["shape"]);
        Assert.Equal("0.3", conc["size_x"]);
        Assert.Equal("0.45", conc["size_y"]);
        Assert.Null(conc["designation"]);

        Assert.Equal("i_shape", SectionMapper.ShapeFromName("UB-Universal Beams", "HEA 300"));
        Assert.Equal("c_shape", SectionMapper.ShapeFromName("C-Channel", "C10X15.3"));
        Assert.Equal("l_shape", SectionMapper.ShapeFromName("L-Angle", "L4X4X1/2"));
        Assert.Equal("open_web", SectionMapper.ShapeFromName("K-Series Bar Joist-Rod Web", "14K1"));
        Assert.Equal("HEA 300", SectionMapper.Designation(null, "HEA 300"));
    }

    [Fact]
    public void LengthStoredInWidthIsDropped()
    {
        var f = SectionMapper.Map(new SectionInput { FamilyName = "Column", TypeName = "x", Width = 12.8, Height = 0.4 });
        Assert.Null(f["size_x"]);
        Assert.Equal("0.4", f["size_y"]);
    }

    [Fact]
    public void ArchitecturalColumnsTakeRectOrRound()
    {
        var a = SectionMapper.ToArchitectural(new Dictionary<string, string?> { ["shape"] = "i_shape", ["size_x"] = "0.3", ["size_y"] = "0.3" });
        Assert.Equal("rect", a["shape"]);
        var r = SectionMapper.ToArchitectural(new Dictionary<string, string?> { ["shape"] = "round_hollow", ["size_x"] = "0.3" });
        Assert.Equal("round", r["shape"]);
        Assert.Null(r["size_y"]);
    }
}

public class RoofMapperTests
{
    [Fact]
    public void UniformHipIsImplied()
    {
        var s = RoofMapper.Classify([30, 30, 30, 30]);
        Assert.Equal(new RoofShape("hip", 30, null), s);
    }

    [Fact]
    public void GableAndShedWriteEdgeSlopes()
    {
        Assert.Equal(new RoofShape("gable", 35, "35;0;35;0"), RoofMapper.Classify([35, null, 35, null]));
        Assert.Equal(new RoofShape("shed", 10, "10;0;0;0"), RoofMapper.Classify([10, null, 0, null]));
        Assert.Equal(new RoofShape("flat", 0, null), RoofMapper.Classify([null, null, null, null]));
        Assert.Equal("flat", RoofMapper.Classify([1.2, null, null, null]).RoofType);
        Assert.Equal("1.2;0;0;0", RoofMapper.Classify([1.2, null, null, null]).EdgeSlopes);
    }

    [Fact]
    public void SlopeTangentToDegrees() => Assert.Equal(45, RoofMapper.SlopeTangentToDegrees(1), 6);

    [Fact]
    public void ExtrusionRoofProfileAndFootprint()
    {
        // A symmetric barrel-ish profile 0..6 m wide, extruded 10 m along +Y.
        var ex = RoofMapper.Extrusion([(0, 3), (3, 4), (6, 3)], 0.2, (0, 0), (1, 0), (0, 1), 0, 10);
        Assert.Equal("0,0;3,1;6,0", ex.Profile);
        Assert.Equal(2.8, ex.BaseOffset, 6);
        Assert.Equal([(0.0, 0.0), (0.0, 10.0), (6.0, 10.0), (6.0, 0.0)], ex.Footprint);
    }
}

public class CurtainGridMapperTests
{
    [Fact]
    public void ExplicitLinesPanelsAndDoorNumbers()
    {
        var f = CurtainGridMapper.Map(6, 4, [1.5, 3, 4.5, 0, 6], [0.9, 3],
        [
            new(0.75, 0.45, "solid"), new(2.25, 0.45, "solid"), new(3.75, 0.45, "solid"), new(5.25, 0.45, "solid"),
            new(2.25, 1.5, "door", "D105"), new(3.75, 1.5, "double_door", "D106"), new(5.25, 3.5, "empty"),
            new(0.75, 1.5, "glass"),
        ]);
        Assert.Equal("1.5;3;4.5", f["v_grids"]);
        Assert.Equal("0.9;3", f["u_grids"]);
        Assert.Null(f["v_grid_count"]);
        Assert.Equal("*:0=solid;1:1=door;2:1=double_door;3:2=empty", f["panels"]);
        Assert.Equal("D105;D106", f["door_numbers"]);
    }

    [Fact]
    public void NoLinesIsOneCell()
    {
        var f = CurtainGridMapper.Map(3, 3, [], [], []);
        Assert.Equal("1", f["v_grid_count"]);
        Assert.Equal("1", f["u_grid_count"]);
        Assert.Null(f["panels"]);
        Assert.Null(f["door_numbers"]);
    }

    [Theory]
    [InlineData(true, "Curtain Wall Dbl Glass", "Double", null, "double_door")]
    [InlineData(true, "Curtain Wall Sgl Glass", "Std", null, "door")]
    [InlineData(false, "System Panel", "Empty", null, "empty")]
    [InlineData(false, "System Panel", "Solid", null, "solid")]
    [InlineData(false, "System Panel", "Glazed", "Glass", "glass")]
    [InlineData(false, "System Panel", "Spandrel", "Metal - Aluminum", "solid")]
    public void PanelKinds(bool isDoor, string fam, string type, string? mat, string expected) =>
        Assert.Equal(expected, CurtainGridMapper.PanelKind(isDoor, fam, type, mat));
}

public class StairMapperTests
{
    static StairRunInput Run(string id, double x0, double y0, double x1, double y1, double z0, double z1) =>
        new(id, x0, y0, z0, x1, y1, z1, 1.2, 9);

    [Fact]
    public void ClassifiesByTurn()
    {
        var a = Run("a", 0, 0, 3, 0, 0, 1.5);
        var b = Run("b", 4, 1, 4, 4, 1.5, 3);
        var c = Run("c", 3, 2, 0, 2, 1.5, 3);
        Assert.Equal("straight", StairMapper.Classify([a]));
        Assert.Equal("quarter_turn", StairMapper.Classify([a, b]));
        Assert.Equal("half_turn", StairMapper.Classify([a, c]));
        Assert.Equal("winder", StairMapper.Classify([a with { Style = "Winder" }]));
        Assert.Equal(["a", "c"], StairMapper.Order([c, a]).Select(r => r.Id));
    }

    [Fact]
    public void RailingSideLookingUp()
    {
        var a = Run("a", 0, 0, 3, 0, 0, 1.5);
        Assert.Equal("left", StairMapper.RailingSide(a, 1.5, 0.6));
        Assert.Equal("right", StairMapper.RailingSide(a, 1.5, -0.6));
    }
}

public class FurnitureMapperTests
{
    [Theory]
    [InlineData("M_Bed-Standard", "King", "bed", "king")]
    [InlineData("Desk", "1525 x 762mm", "desk", null)]
    [InlineData("Chair-Task", "Office chair", "office_chair", null)]
    [InlineData("M_Chair-Breuer", "Chair-Breuer", "chair", null)]
    [InlineData("Table-Coffee", "Round", "coffee_table", "round")]
    [InlineData("Sofa-Corbu", "3 seat", "sofa", null)]
    [InlineData("Base Cabinet-Single Door", "450mm", "base_cabinet", null)]
    [InlineData("Upper Cabinet", "600", "wall_cabinet", null)]
    [InlineData("RPC Tree - Deciduous", "Red Maple", "tree", null)]
    [InlineData("RPC Male", "Alex", "person", null)]
    [InlineData("双人床", "1800", "bed", "double")]
    [InlineData("Embedded Box", "A", "generic_box", null)]
    [InlineData("Manager station", "A", "generic_box", null)]
    public void GuessesFamilies(string family, string type, string expected, string? variant)
    {
        var g = FurnitureMapper.Guess(family, type);
        Assert.Equal(expected, g.Family);
        if (variant is not null) Assert.Equal(variant, g.Variant);
        Assert.Equal(expected != "generic_box", g.Guessed);
    }

    [Fact]
    public void PlantingCategoryFallback() => Assert.Equal("plant", FurnitureMapper.Guess("Zz", "Yy", "Planting").Family);

    [Fact]
    public void FootprintCenterFollowsRotation()
    {
        // A 2 x 1 family whose insertion point is its back-left corner, turned 90°.
        var (x, y) = FurnitureMapper.FootprintCenter(10, 10, Math.PI / 2, 0, 2, -1, 0);
        Assert.Equal(10.5, x, 6);
        Assert.Equal(11, y, 6);
    }
}

public class FoundationMapperTests
{
    [Theory]
    [InlineData("Floor", "", "", "raft")]
    [InlineData("WallFoundation", "", "", "strip")]
    [InlineData("FamilyInstance", "M_Footing-Rectangular", "1800x1200x450mm", "pad")]
    [InlineData("FamilyInstance", "Pile-Steel Pipe", "600mm", "pile")]
    [InlineData("FamilyInstance", "M_Pile Cap-4 Pile", "1500", "pile_cap")]
    [InlineData("FamilyInstance", "桩承台", "CT-1", "pile_cap")]
    public void Kinds(string cls, string fam, string type, string expected) =>
        Assert.Equal(expected, FoundationMapper.Kind(cls, fam, type));

    [Fact]
    public void RectFootprintRotates()
    {
        var p = FoundationMapper.RectFootprint(0, 0, 2, 1, 90);
        Assert.Equal(0.5, p[0].X, 6);
        Assert.Equal(-1, p[0].Y, 6);
    }
}

public class MepMapperTests
{
    [Theory]
    [InlineData("Elbow", "elbow")]
    [InlineData("Tee", "tee")]
    [InlineData("Wye", "wye")]
    [InlineData("Cross", "cross")]
    [InlineData("Transition", "transition")]
    [InlineData("Union", "coupling")]
    [InlineData("Cap", "cap")]
    [InlineData("TapPerpendicular", "tap")]
    [InlineData("MultiPort", null)]
    public void Fittings(string partType, string? expected) => Assert.Equal(expected, MepMapper.Fitting(partType));

    [Theory]
    [InlineData("Gate Valve", "50mm", null, "gate_valve")]
    [InlineData("Fire Damper - Rectangular", "", "Damper", "fire_damper")]
    [InlineData("Damper-Volume", "", "Damper", "damper")]
    [InlineData("Check Valve", "", null, "check_valve")]
    [InlineData("Y-Strainer", "", null, "strainer")]
    [InlineData("Balancing Valve", "", null, "balancing_valve")]
    [InlineData("Valve", "", "ValveNormal", "valve")]
    [InlineData("Thingy", "", null, "other_accessory")]
    public void Accessories(string fam, string type, string? part, string expected) =>
        Assert.Equal(expected, MepMapper.AccessoryKind(fam, type, part));

    [Theory]
    [InlineData(null, "SupplyAir", "Supply Air", "SA")]
    [InlineData(null, "SupplyAir", "Outside Air", "OA")]
    [InlineData(null, "SupplyHydronic", "Chilled Water Supply", "CHWS")]
    [InlineData(null, "ReturnHydronic", "Heating Water Return", "HWR")]
    [InlineData(null, "DomesticColdWater", "Domestic Cold Water", "DCW")]
    [InlineData(null, "Sanitary", "Sanitary", "SAN")]
    [InlineData(null, "FireProtectWet", "Wet Fire", "FP")]
    [InlineData("chws", "SupplyHydronic", "x", "CHWS")]
    public void SystemTags(string? abbr, string cls, string name, string expected) =>
        Assert.Equal(expected, MepMapper.SystemTag(abbr, cls, name));

    [Theory]
    [InlineData("SupplyAir", "hvac")]
    [InlineData("Vent", "plumbing")]
    [InlineData("FireProtectDry", "fire")]
    [InlineData("PowerCircuit", "electrical")]
    [InlineData("DataCircuit", "data")]
    public void Disciplines(string cls, string expected) => Assert.Equal(expected, MepMapper.Discipline(cls));

    [Theory]
    [InlineData("OST_PlumbingFixtures", "toilet-domestic", "water_closet")]
    [InlineData("OST_PlumbingFixtures", "sink kitchen", "sink")]
    [InlineData("OST_DuctTerminal", "return diffuser", "return_air_grille")]
    [InlineData("OST_LightingFixtures", "exit sign emergency", "emergency_light")]
    [InlineData("OST_ElectricalFixtures", "duplex receptacle", "power_outlet")]
    [InlineData("OST_FireAlarmDevices", "smoke detector", "fire_alarm_device")]
    public void Terminals(string cat, string name, string expected) => Assert.Equal(expected, MepMapper.TerminalType(cat, name));

    [Fact]
    public void Equipment()
    {
        Assert.Equal("ahu", MepMapper.EquipmentType("air handling unit - ahu"));
        Assert.Equal("fcu", MepMapper.EquipmentType("fan coil unit"));
        Assert.Equal("coil", MepMapper.EquipmentType("heating coil"));
        Assert.Equal("panelboard", MepMapper.EquipmentType("lighting and appliance panelboard"));
        Assert.Equal("panelboard", MepMapper.EquipmentType("weird box", electricalCategory: true));
        Assert.Equal(1800, MepMapper.LoadWatts(2000, 0.9)!.Value, 6);
    }
}

public class WallMapperTests
{
    [Fact]
    public void ReversesWhenExteriorIsOnTheRight()
    {
        // Along +X: left normal is +Y.
        Assert.False(WallMapper.ShouldReverse(1, 0, 0, 1));
        Assert.True(WallMapper.ShouldReverse(1, 0, 0, -1));
    }

    [Fact]
    public void ReverseLineSwapsEndsAndArcSweep()
    {
        var row = new Dictionary<string, string?>
        {
            ["start_x"] = "0", ["start_y"] = "0", ["end_x"] = "4", ["end_y"] = "0",
            ["_svg_d"] = "M 0,0 A 2,2 0 0,1 4,0",
        };
        WallMapper.ReverseLine(row);
        Assert.Equal("4", row["start_x"]);
        Assert.Equal("0", row["end_x"]);
        Assert.Equal("M 4,0 A 2,2 0 0,0 0,0", row["_svg_d"]);
    }

    [Fact]
    public void ReverseHostedMirrorsPositionHingeAndSwing()
    {
        var row = new Dictionary<string, string?> { ["position"] = "1.5", ["hinge_position"] = "start", ["swing_side"] = "left" };
        WallMapper.ReverseHosted(row, 5);
        Assert.Equal("3.5", row["position"]);
        Assert.Equal("end", row["hinge_position"]);
        Assert.Equal("right", row["swing_side"]);
    }

    // A 10 x 8 box of 0.2 m walls drawn clockwise (exterior on the left).
    internal static readonly WallLine[] Box =
    [
        new("w1", 0, 0, 0, 8, 0.2), new("w2", 0, 8, 10, 8, 0.2), new("w3", 10, 8, 10, 0, 0.2), new("w4", 10, 0, 0, 0, 0.2),
    ];

    [Fact]
    public void MatchesInteriorFaceBoundary()
    {
        var b = WallMapper.MatchBoundary([(0.1, 0.1), (9.9, 0.1), (9.9, 7.9), (0.1, 7.9)], Box, "interior");
        Assert.NotNull(b);
        Assert.Equal("interior", b!.Face);
        Assert.Equal(0, b.Offset);
        Assert.Equal(4, b.WallIds.Count);
    }

    [Fact]
    public void MatchesRoofOverhang()
    {
        var b = WallMapper.MatchBoundary([(-0.6, -0.6), (10.6, -0.6), (10.6, 8.6), (-0.6, 8.6)], Box, "exterior");
        Assert.NotNull(b);
        Assert.Equal("exterior", b!.Face);
        Assert.Equal(0.5, b.Offset, 6);
    }

    [Fact]
    public void CoreFaceUsesLayers()
    {
        // Exterior 0.1 insulation + 0.2 core + 0.015 finish: core between +0.0575 and -0.1425.
        var walls = Box.Select(w => w with { Thickness = 0.315, CoreHi = 0.0575, CoreLo = -0.1425 }).ToArray();
        var b = WallMapper.MatchBoundary([(0.1425, 0.1425), (9.8575, 0.1425), (9.8575, 7.8575), (0.1425, 7.8575)], walls, "core");
        Assert.NotNull(b);
        Assert.Equal("core", b!.Face);
    }

    [Fact]
    public void SketchedOutlineDoesNotMatch()
    {
        Assert.Null(WallMapper.MatchBoundary([(2, 2), (5, 2), (5, 5), (2, 5)], Box, "core"));
        // Mixed faces (interior on one wall, centre line on the others)
        Assert.Null(WallMapper.MatchBoundary([(0.1, 0), (10, 0), (10, 8), (0.1, 8)], Box, "core"));
    }
}

public class TypeInheritanceTests
{
    [Fact]
    public void StripsEqualValuesKeepsOverrides()
    {
        var types = new Dictionary<string, Dictionary<string, string?>>
        {
            ["T"] = new() { ["id"] = "T", ["thickness"] = "0.3254", ["material"] = "concrete" },
        };
        var a = new Dictionary<string, string?> { ["type_id"] = "T", ["thickness"] = "0.325", ["material"] = "concrete" };
        var b = new Dictionary<string, string?> { ["type_id"] = "T", ["thickness"] = "0.35", ["material"] = "brick" };
        TypeInheritance.StripInherited("wall", [a, b], types);
        Assert.Null(a["thickness"]);
        Assert.Null(a["material"]);
        Assert.Equal("0.35", b["thickness"]);
        Assert.Equal("brick", b["material"]);

        var fill = new Dictionary<string, string?> { ["type_id"] = "T" };
        TypeInheritance.FillFromType("wall", fill, types["T"]);
        Assert.Equal("0.3254", fill["thickness"]);
    }
}

public class AnnotationMapperTests
{
    [Fact]
    public void ChainDimensionRows()
    {
        var rows = AnnotationMapper.DimensionRows("D", 0, 1, [new(0, 1, 2), new(0, 3.5, 3, "EQ")]);
        Assert.Equal(2, rows.Count);
        Assert.Equal("90", rows[0]["direction"]);
        Assert.Equal("0", rows[0]["start_y"]);
        Assert.Equal("2", rows[0]["end_y"]);
        Assert.Equal("EQ", rows[1]["text"]);
        Assert.Equal("D:seg:1", rows[1]["id"]);
    }

    [Fact]
    public void PaperSizeAndRotation()
    {
        Assert.Equal(2.5, AnnotationMapper.PaperSizeMm(0.0025));
        Assert.Equal(270, AnnotationMapper.RotationDeg(0, -1));
        Assert.Equal(0, AnnotationMapper.RotationDeg(1, 0));
    }
}

public class OpeningMapperTests
{
    [Theory]
    [InlineData(null, "M_Single-Flush", "0915 x 2134mm", "single_swing")]
    [InlineData(null, "M_Double-Flush", "1830 x 2134mm", "double_swing")]
    [InlineData(null, "Door-Sliding-2 panel", "", "sliding")]
    [InlineData("推拉", "门", "", "sliding")]
    public void Doors(string? op, string fam, string type, string expected) =>
        Assert.Equal(expected, OpeningMapper.DoorOperation(op, fam, type));

    [Theory]
    [InlineData(null, "M_Fixed", "0915 x 1220mm", "fixed")]
    [InlineData(null, "M_Window-Casement-Double", "", "casement")]
    [InlineData("tilt and turn", "W", "", "tilt_and_turn")]
    [InlineData(null, "Generic", "", null)]
    public void Windows(string? op, string fam, string type, string? expected) =>
        Assert.Equal(expected, OpeningMapper.WindowOperation(op, fam, type));
}

public class ShortIdGeneratorTests
{
    [Fact]
    public void TypesGetSlugIdsAndElementsCounters()
    {
        var gen = new ShortIdGenerator();
        Assert.Equal("wt-exterior-concrete-200", gen.GetOrAssign("wall_type", "u1", "global", "Exterior - Concrete 200"));
        Assert.Equal("wt-exterior-concrete-200-2", gen.GetOrAssign("wall_type", "u2", "global", "Exterior: Concrete 200"));
        Assert.Equal("w-1", gen.GetOrAssign("wall", "u3", "lv-1"));
        Assert.Equal("w-1", gen.GetOrAssign("wall", "u4", "lv-2"));
    }

    [Fact]
    public void SeededIdsWithAnotherPrefixAreReassigned()
    {
        var gen = new ShortIdGenerator();
        gen.Seed("u1", "w-7");
        Assert.Equal("sw-1", gen.GetOrAssign("structure_wall", "u1", "lv-1"));
        gen.Seed("u2", "w-9");
        Assert.Equal("w-9", gen.GetOrAssign("wall", "u2", "lv-1"));
    }

    [Fact]
    public void UnexportedSeedsDoNotResolve()
    {
        var gen = new ShortIdGenerator();
        gen.Seed("u1", "w-7");
        Assert.Null(gen.Resolve("u1"));
        Assert.Empty(gen.Mappings);
    }

    [Fact]
    public void BoundaryWallsDropWhenAWallIsMissing()
    {
        var gen = new ShortIdGenerator();
        gen.GetOrAssign("wall", "a", "lv-1");
        var row = new Dictionary<string, string?> { ["boundary_walls"] = "a;b", ["boundary_face"] = "interior" };
        gen.ResolveOtherReferences(row);
        Assert.Null(row["boundary_walls"]);
        Assert.Null(row["boundary_face"]);
        var ok = new Dictionary<string, string?> { ["boundary_walls"] = "a" };
        gen.ResolveOtherReferences(ok);
        Assert.Equal("w-1", ok["boundary_walls"]);
    }
}
