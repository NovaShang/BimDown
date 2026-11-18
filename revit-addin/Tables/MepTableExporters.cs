using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.DB.Plumbing;
using BimDown.RevitAddin.Extractors;
using BimDown.RevitAddin.Mapping;
using static BimDown.RevitAddin.RevitReaders;

namespace BimDown.RevitAddin.Tables;

public static class MepTableExporters
{
    /// <summary>
    /// Builds the extractor chain for MEP curves (duct, pipe, cable_tray, conduit).
    /// Uses MepCurveGeometryExtractor (connector-based endpoints) instead of the
    /// generic LineElement/SpatialLineElement extractors.
    /// </summary>
    static IFieldExtractor[] ExpandMepCurve() =>
        [new ElementExtractor(), new MepCurveGeometryExtractor(), new SectionProfileExtractor(), new MepSystemExtractor(), new MepConnectedSegmentExtractor()];

    static double? InsulationThickness(Element e)
    {
        try
        {
            foreach (var id in InsulationLiningBase.GetInsulationIds(e.Document, e.Id))
                if (e.Document.GetElement(id) is InsulationLiningBase ins && ins.Thickness > 0)
                    return M(ins.Thickness);
        }
        catch { }
        return null;
    }

    public static ITableExporter Duct() => new TableExporter(
        "duct",
        [BuiltInCategory.OST_DuctCurves, BuiltInCategory.OST_FlexDuctCurves],
        new CompositeExtractor(
            ExpandMepCurve(),
            ["insulation_thickness", "flexible"],
            e => new Dictionary<string, string?>
            {
                ["insulation_thickness"] = Names.Num(InsulationThickness(e), 3),
                ["flexible"] = e.Category?.BuiltInCategory == BuiltInCategory.OST_FlexDuctCurves ? "true" : null,
            }));

    public static ITableExporter Pipe() => new TableExporter(
        "pipe",
        [BuiltInCategory.OST_PipeCurves, BuiltInCategory.OST_FlexPipeCurves],
        new CompositeExtractor(
            ExpandMepCurve(),
            ["insulation_thickness", "material"],
            e =>
            {
                string? materialName = null;
                if (e is Pipe pipe)
                {
                    try { materialName = MaterialName(e.Document, pipe.PipeSegment?.MaterialId); } catch { }
                }
                materialName ??= e.get_Parameter(BuiltInParameter.RBS_PIPE_MATERIAL_PARAM)?.AsValueString()
                                 ?? e.get_Parameter(BuiltInParameter.RBS_PIPE_MATERIAL_PARAM)?.AsString();
                return new Dictionary<string, string?>
                {
                    ["insulation_thickness"] = Names.Num(InsulationThickness(e), 3),
                    ["material"] = MaterialMapper.PipeMaterial(materialName),
                };
            }));

    public static ITableExporter CableTray() => new TableExporter(
        "cable_tray",
        [BuiltInCategory.OST_CableTray],
        new CompositeExtractor(ExpandMepCurve()));

    public static ITableExporter Conduit() => new TableExporter(
        "conduit",
        [BuiltInCategory.OST_Conduit],
        new CompositeExtractor(ExpandMepCurve()));

    static readonly BuiltInCategory[] FittingCategories =
        [BuiltInCategory.OST_DuctFitting, BuiltInCategory.OST_PipeFitting, BuiltInCategory.OST_CableTrayFitting, BuiltInCategory.OST_ConduitFitting];

    /// <summary>
    /// Fittings (passive: `fitting` from the Revit part type, `kind` empty) and
    /// accessories (`kind` from the family name, body size from the first connector).
    /// </summary>
    public static ITableExporter MepNode() => new TableExporter(
        "mep_node",
        [.. FittingCategories, BuiltInCategory.OST_DuctAccessory, BuiltInCategory.OST_PipeAccessory],
        new CompositeExtractor(
            [.. CompositeExtractor.ExpandPointElement(), new MepSystemExtractor()],
            ["kind", "fitting", "family", "type", "shape", "size_w", "size_h"],
            e =>
            {
                var d = ExtractFamilyAndType(e);
                if (e is not FamilyInstance fi) return d;
                var partType = (fi.MEPModel as MechanicalFitting)?.PartType.ToString();
                var cat = fi.Category?.BuiltInCategory;
                if (cat is { } c && FittingCategories.Contains(c))
                {
                    d["fitting"] = MepMapper.Fitting(partType);
                    return d;
                }
                d["kind"] = MepMapper.AccessoryKind(fi.Symbol.FamilyName, fi.Symbol.Name, partType);
                var conn = fi.MEPModel?.ConnectorManager?.Connectors?.Cast<Connector>().FirstOrDefault();
                if (conn is not null)
                {
                    try
                    {
                        if (conn.Shape == ConnectorProfileType.Rectangular)
                        {
                            d["shape"] = "rect";
                            d["size_w"] = Names.Num(M(conn.Width), 3);
                            d["size_h"] = Names.Num(M(conn.Height), 3);
                        }
                        else
                        {
                            d["shape"] = "round";
                            d["size_w"] = Names.Num(M(conn.Radius * 2), 3);
                        }
                    }
                    catch { }
                }
                return d;
            }));

    static readonly BuiltInCategory[] TerminalCategories =
    [
        BuiltInCategory.OST_DuctTerminal, BuiltInCategory.OST_Sprinklers, BuiltInCategory.OST_LightingFixtures,
        BuiltInCategory.OST_ElectricalFixtures, BuiltInCategory.OST_PlumbingFixtures, BuiltInCategory.OST_LightingDevices,
        BuiltInCategory.OST_FireAlarmDevices, BuiltInCategory.OST_DataDevices, BuiltInCategory.OST_CommunicationDevices,
        BuiltInCategory.OST_TelephoneDevices,
    ];

    internal static readonly BuiltInCategory[] DeviceCategories =
        [BuiltInCategory.OST_MechanicalEquipment, BuiltInCategory.OST_ElectricalEquipment, .. TerminalCategories];

    public static ITableExporter Equipment() => new TableExporter(
        "equipment",
        [BuiltInCategory.OST_MechanicalEquipment, BuiltInCategory.OST_ElectricalEquipment],
        new CompositeExtractor(
            [.. CompositeExtractor.ExpandPointElement(), new MepSystemExtractor()],
            ["equipment_type", "family", "type", "flow", "load", "circuit_id"],
            e =>
            {
                var d = ExtractFamilyAndType(e);
                d["equipment_type"] = MepMapper.EquipmentType(GetFamilyAndTypeName(e),
                    e.Category?.BuiltInCategory == BuiltInCategory.OST_ElectricalEquipment);
                AddDesignData(e, d);
                return d;
            }));

    public static ITableExporter Terminal() => new TableExporter(
        "terminal",
        TerminalCategories,
        new CompositeExtractor(
            [.. CompositeExtractor.ExpandPointElement(), new MepSystemExtractor()],
            ["terminal_type", "family", "type", "flow", "load", "circuit_id"],
            e =>
            {
                var d = ExtractFamilyAndType(e);
                d["terminal_type"] = MepMapper.TerminalType(e.Category?.BuiltInCategory.ToString() ?? "", GetFamilyAndTypeName(e));
                AddDesignData(e, d);
                return d;
            }),
        // Plumbing fixtures without pipe connections are furniture-like, but a
        // plumbing fixture is still a terminal: keep them all here.
        e => e is FamilyInstance { SuperComponent: null });

    /// <summary>flow (L/s), load (W) and the power circuit feeding the device.</summary>
    static void AddDesignData(Element e, Dictionary<string, string?> d)
    {
        var flow = FromInternal(e.get_Parameter(BuiltInParameter.RBS_DUCT_FLOW_PARAM), UnitTypeId.LitersPerSecond)
                   ?? FromInternal(e.get_Parameter(BuiltInParameter.RBS_PIPE_FLOW_PARAM), UnitTypeId.LitersPerSecond);
        d["flow"] = Names.Num(flow, 2);
        var va = FromInternal(e.get_Parameter(BuiltInParameter.RBS_ELEC_APPARENT_LOAD), UnitTypeId.VoltAmperes);
        var pf = e.get_Parameter(BuiltInParameter.RBS_ELEC_POWER_FACTOR)?.AsDouble();
        d["load"] = Names.Num(MepMapper.LoadWatts(va, pf), 1);
        d["circuit_id"] = FeedingCircuit(e)?.UniqueId;
    }

    /// <summary>The power circuit a device is on (not the circuits a panel feeds).</summary>
    internal static ElectricalSystem? FeedingCircuit(Element e)
    {
        if (e is not FamilyInstance fi || fi.MEPModel is null) return null;
        try
        {
            foreach (var sys in fi.MEPModel.GetElectricalSystems())
            {
                if (sys.SystemType is not (ElectricalSystemType.PowerCircuit or ElectricalSystemType.PowerBalanced or ElectricalSystemType.PowerUnBalanced))
                    continue;
                if (sys.BaseEquipment?.Id == fi.Id) continue;
                return sys;
            }
        }
        catch { }
        return null;
    }

    /// <summary>
    /// Power circuits: host_id = the panel, number = circuit number, name = load
    /// name, voltage (V), poles, rating (A); stored next to the panel.
    /// </summary>
    public static ITableExporter Circuit() => new CircuitExporter();

    sealed class CircuitExporter : ITableExporter
    {
        public string TableName => "circuit";
        public IReadOnlyList<string> Columns { get; } = ["id", "number", "host_id", "name", "voltage", "poles", "rating"];
        public IReadOnlyList<string> CsvColumns => Columns;

        public List<Dictionary<string, string?>> Export(Document doc)
        {
            var rows = new List<Dictionary<string, string?>>();
            foreach (var sys in new FilteredElementCollector(doc).OfClass(typeof(ElectricalSystem)).Cast<ElectricalSystem>().OrderBy(s => s.Id.Value))
            {
                try
                {
                    if (sys.SystemType is not (ElectricalSystemType.PowerCircuit or ElectricalSystemType.PowerBalanced or ElectricalSystemType.PowerUnBalanced))
                        continue;
                    if (sys.BaseEquipment is not { } panel) continue;
                    rows.Add(new Dictionary<string, string?>
                    {
                        ["id"] = sys.UniqueId,
                        ["number"] = string.IsNullOrWhiteSpace(sys.CircuitNumber) ? null : sys.CircuitNumber,
                        ["host_id"] = panel.UniqueId,
                        ["name"] = string.IsNullOrWhiteSpace(sys.LoadName) ? null : sys.LoadName,
                        ["voltage"] = Names.Num(Safe(() => UnitUtils.ConvertFromInternalUnits(sys.Voltage, UnitTypeId.Volts)), 0),
                        ["poles"] = sys.PolesNumber > 0 ? sys.PolesNumber.ToString() : null,
                        ["rating"] = Names.Num(Safe(() => UnitUtils.ConvertFromInternalUnits(sys.Rating, UnitTypeId.Amperes)), 1),
                        // The circuit lives in its panel's level directory.
                        ["level_id"] = panel.Document.GetElement(panel.LevelId)?.UniqueId,
                    });
                }
                catch { }
            }
            return rows;
        }

        static double? Safe(Func<double> f)
        {
            try { var v = f(); return v > 0 ? v : null; }
            catch { return null; }
        }
    }

    /// <summary>
    /// mep_system: one row per system tag used in the model (MEPSystemType
    /// abbreviation or the classification's code) with name, line colour and discipline.
    /// </summary>
    public static ITableExporter MepSystem() => new MepSystemExporter();

    sealed class MepSystemExporter : ITableExporter
    {
        public string TableName => "mep_system";
        public bool IsGlobal => true;
        public IReadOnlyList<string> Columns { get; } = ["id", "system_type", "name", "color", "discipline"];
        public IReadOnlyList<string> CsvColumns => Columns;

        public List<Dictionary<string, string?>> Export(Document doc)
        {
            var rows = new List<Dictionary<string, string?>>();
            var seen = new HashSet<string>();
            var typeIds = new FilteredElementCollector(doc).OfClass(typeof(MEPSystem)).Cast<MEPSystem>()
                .Select(s => s.GetTypeId()).Where(id => id != ElementId.InvalidElementId).Distinct();
            foreach (var tid in typeIds.OrderBy(id => id.Value))
            {
                if (doc.GetElement(tid) is not MEPSystemType mst) continue;
                var tag = MepMapper.SystemTag(mst.Abbreviation, mst.SystemClassification.ToString(), mst.Name);
                if (tag is null || !seen.Add(tag)) continue;
                var c = mst.LineColor;
                rows.Add(new Dictionary<string, string?>
                {
                    ["id"] = mst.UniqueId,
                    ["system_type"] = tag,
                    ["name"] = mst.Name,
                    ["color"] = c is { IsValid: true } && !(c.Red == 0 && c.Green == 0 && c.Blue == 0) ? MepMapper.ColorHex(c.Red, c.Green, c.Blue) : null,
                    ["discipline"] = MepMapper.Discipline(mst.SystemClassification.ToString()),
                });
            }
            return rows;
        }
    }

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

    static string? GetFamilyAndTypeName(Element e)
    {
        if (e is not FamilyInstance fi) return e.Name;
        return $"{fi.Symbol.Family.Name} {fi.Symbol.Name}".ToLowerInvariant();
    }
}
