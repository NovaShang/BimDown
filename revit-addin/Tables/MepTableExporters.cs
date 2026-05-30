using Autodesk.Revit.DB;
using BimDown.RevitAddin.Extractors;

namespace BimDown.RevitAddin.Tables;

public static class MepTableExporters
{
    /// <summary>
    /// Builds the extractor chain for MEP curves (duct, pipe, cable_tray, conduit).
    /// Uses MepCurveGeometryExtractor (connector-based endpoints) instead of the
    /// generic LineElement/SpatialLineElement extractors.
    /// </summary>
    static IFieldExtractor[] ExpandMepCurve() =>
        [new ElementExtractor(), new MepCurveGeometryExtractor()];

    public static ITableExporter Duct() => new TableExporter(
        "duct",
        [BuiltInCategory.OST_DuctCurves],
        new CompositeExtractor(
            [..ExpandMepCurve(), new SectionProfileExtractor(), new MepSystemExtractor(), new MepConnectedSegmentExtractor()]));

    public static ITableExporter Pipe() => new TableExporter(
        "pipe",
        [BuiltInCategory.OST_PipeCurves],
        new CompositeExtractor(
            [..ExpandMepCurve(), new SectionProfileExtractor(), new MepSystemExtractor(), new MepConnectedSegmentExtractor()]));

    public static ITableExporter CableTray() => new TableExporter(
        "cable_tray",
        [BuiltInCategory.OST_CableTray],
        new CompositeExtractor(
            [..ExpandMepCurve(), new SectionProfileExtractor(), new MepSystemExtractor(), new MepConnectedSegmentExtractor()]));

    public static ITableExporter Conduit() => new TableExporter(
        "conduit",
        [BuiltInCategory.OST_Conduit],
        new CompositeExtractor(
            [..ExpandMepCurve(), new SectionProfileExtractor(), new MepSystemExtractor(), new MepConnectedSegmentExtractor()]));

    public static ITableExporter MepNode() => new TableExporter(
        "mep_node",
        [BuiltInCategory.OST_DuctFitting, BuiltInCategory.OST_PipeFitting, BuiltInCategory.OST_CableTrayFitting, BuiltInCategory.OST_ConduitFitting,
         BuiltInCategory.OST_DuctAccessory, BuiltInCategory.OST_PipeAccessory],
        new CompositeExtractor(
            [..CompositeExtractor.ExpandPointElement(), new MepSystemExtractor(), new MepNodeExtractor()],
            ["family", "type"],
            ExtractFamilyAndType));

    public static ITableExporter Equipment() => new TableExporter(
        "equipment",
        [BuiltInCategory.OST_MechanicalEquipment, BuiltInCategory.OST_ElectricalEquipment],
        new CompositeExtractor(
            [..CompositeExtractor.ExpandPointElement(), new MepSystemExtractor()],
            ["equipment_type", "family", "type"],
            e =>
            {
                var d = ExtractFamilyAndType(e);
                d["equipment_type"] = ClassifyEquipmentType(e);
                return d;
            }));

    public static ITableExporter Terminal() => new TableExporter(
        "terminal",
        [BuiltInCategory.OST_DuctTerminal, BuiltInCategory.OST_Sprinklers, BuiltInCategory.OST_LightingFixtures, BuiltInCategory.OST_ElectricalFixtures],
        new CompositeExtractor(
            [..CompositeExtractor.ExpandPointElement(), new MepSystemExtractor()],
            ["terminal_type", "family", "type"],
            e =>
            {
                var d = ExtractFamilyAndType(e);
                d["terminal_type"] = ClassifyTerminalType(e);
                return d;
            }));

    static Dictionary<string, string?> ExtractFamilyAndType(Element e)
    {
        if (e is FamilyInstance fi)
        {
            return new Dictionary<string, string?>
            {
                ["family"] = fi.Symbol?.Family?.Name,
                ["type"] = fi.Symbol?.Name,
            };
        }
        return new Dictionary<string, string?> { ["family"] = null, ["type"] = null };
    }

    static string? ClassifyEquipmentType(Element e)
    {
        var name = GetFamilyAndTypeName(e);
        if (name is null) return null;

        return name switch
        {
            _ when Contains(name, "ahu", "air handling", "空调箱", "空调机组") => "ahu",
            _ when Contains(name, "fcu", "fan coil", "风机盘管") => "fcu",
            _ when Contains(name, "chiller", "冷水机") => "chiller",
            _ when Contains(name, "boiler", "锅炉") => "boiler",
            _ when Contains(name, "cooling tower", "冷却塔") => "cooling_tower",
            _ when Contains(name, "fan", "风机") && !Contains(name, "coil") => "fan",
            _ when Contains(name, "pump", "水泵", "泵") => "pump",
            _ when Contains(name, "transformer", "变压器") => "transformer",
            _ when Contains(name, "panel", "panelboard", "配电箱", "配电柜") => "panelboard",
            _ when Contains(name, "generator", "发电机") => "generator",
            _ when Contains(name, "water heater", "热水器") => "water_heater",
            _ when Contains(name, "tank", "水箱", "罐") => "tank",
            _ => "other"
        };
    }

    static string? ClassifyTerminalType(Element e)
    {
        // Use Revit category as primary signal
        var cat = e.Category?.BuiltInCategory;
        if (cat == BuiltInCategory.OST_Sprinklers) return "sprinkler_head";
        if (cat == BuiltInCategory.OST_LightingFixtures) return "light_fixture";
        if (cat == BuiltInCategory.OST_ElectricalFixtures)
        {
            var name = GetFamilyAndTypeName(e);
            if (name is not null && Contains(name, "data", "rj", "network", "数据", "网络"))
                return "data_outlet";
            return "power_outlet";
        }

        // DuctTerminal — distinguish supply/return/exhaust from family name
        if (cat == BuiltInCategory.OST_DuctTerminal)
        {
            var name = GetFamilyAndTypeName(e);
            if (name is null) return "supply_air_diffuser";

            return name switch
            {
                _ when Contains(name, "return", "回风") => "return_air_grille",
                _ when Contains(name, "exhaust", "排风", "排气") => "exhaust_air_grille",
                _ => "supply_air_diffuser"
            };
        }

        return "other";
    }

    static string? GetFamilyAndTypeName(Element e)
    {
        if (e is not FamilyInstance fi) return e.Name;
        var familyName = fi.Symbol.Family.Name;
        var typeName = fi.Symbol.Name;
        return $"{familyName} {typeName}".ToLowerInvariant();
    }

    static bool Contains(string text, params string[] keywords) =>
        keywords.Any(k => text.Contains(k, StringComparison.OrdinalIgnoreCase));
}
