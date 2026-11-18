using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Structure;
using BimDown.RevitAddin.Extractors;
using BimDown.RevitAddin.Mapping;
using static BimDown.RevitAddin.RevitReaders;

namespace BimDown.RevitAddin.Tables;

/// <summary>
/// A global/ type table (Revit "family type"): one row per type used by an
/// instance of <paramref name="instanceCategories"/>. Rows are keyed by the
/// type's UniqueId; ProjectWriter.ApplyTypes later drops types no exported
/// instance references and blanks instance values the type supplies.
/// </summary>
class TypeTableExporter(
    string tableName,
    string[] columns,
    BuiltInCategory[] instanceCategories,
    Func<Element, Dictionary<string, string?>?> extract,
    Func<Element, bool>? instanceFilter = null) : ITableExporter
{
    public string TableName => tableName;
    public bool IsGlobal => true;
    public IReadOnlyList<string> Columns => columns;
    public IReadOnlyList<string> CsvColumns => columns;

    public List<Dictionary<string, string?>> Export(Document doc)
    {
        var rows = new List<Dictionary<string, string?>>();
        foreach (var type in TypeTableExporters.UsedTypes(doc, instanceCategories, instanceFilter))
        {
            try
            {
                var row = extract(type);
                if (row is null) continue;
                row["id"] = type.UniqueId;
                row.TryAdd("name", type.Name);
                rows.Add(row);
            }
            catch { /* skip types that fail */ }
        }
        return rows;
    }
}

public static class TypeTableExporters
{
    static readonly string[] Layered = ["id", "name", "description", "material", "thickness"];
    static readonly string[] Section = ["id", "name", "description", "material", "shape", "size_x", "size_y", "flange", "web", "thickness", "root_radius", "designation", "material_grade"];
    static readonly string[] Fenestration = ["id", "name", "description", "material", "width", "height", "operation", "frame_width", "u_value", "shgc", "vt"];

    internal static readonly BuiltInCategory[] FurnitureCategories =
    [
        BuiltInCategory.OST_Furniture, BuiltInCategory.OST_FurnitureSystems, BuiltInCategory.OST_Casework,
        BuiltInCategory.OST_Planting, BuiltInCategory.OST_Entourage, BuiltInCategory.OST_Parking,
        BuiltInCategory.OST_SpecialityEquipment,
    ];

    /// <summary>Distinct types of the instances in the categories, in id order.</summary>
    internal static IEnumerable<Element> UsedTypes(Document doc, BuiltInCategory[] categories, Func<Element, bool>? filter)
    {
        var seen = new HashSet<ElementId>();
        foreach (var cat in categories)
        {
            foreach (var e in new FilteredElementCollector(doc).OfCategory(cat).WhereElementIsNotElementType().OrderBy(e => e.Id.Value))
            {
                if (filter is not null && !filter(e)) continue;
                var tid = e.GetTypeId();
                if (tid is null || tid == ElementId.InvalidElementId || !seen.Add(tid)) continue;
                if (doc.GetElement(tid) is { } t) yield return t;
            }
        }
    }

    static Dictionary<string, string?> LayeredRow(Element type, CompoundStructure? cs, double? ownWidth)
    {
        var layers = Layers(type.Document, cs);
        var row = LayerMapper.TypeRow(type.UniqueId, type.Name, layers, ownWidth);
        row["description"] = Description(type);
        return row;
    }

    static string? Description(Element type)
    {
        var d = type.get_Parameter(BuiltInParameter.ALL_MODEL_DESCRIPTION)?.AsString();
        return string.IsNullOrWhiteSpace(d) ? null : d;
    }

    public static ITableExporter WallType() => new TypeTableExporter("wall_type", Layered,
        [BuiltInCategory.OST_Walls],
        t => t is WallType { Kind: WallKind.Basic } wt ? LayeredRow(wt, wt.GetCompoundStructure(), M(wt.Width)) : null,
        e => e is Wall { WallType.Kind: WallKind.Basic });

    public static ITableExporter SlabType() => new TypeTableExporter("slab_type", [.. Layered, "material_grade"],
        [BuiltInCategory.OST_Floors],
        t =>
        {
            if (t is not FloorType ft) return null;
            var row = LayeredRow(ft, ft.GetCompoundStructure(),
                ft.get_Parameter(BuiltInParameter.FLOOR_ATTR_DEFAULT_THICKNESS_PARAM)?.AsDouble() is { } th ? M(th) : null);
            row["material_grade"] = MaterialMapper.MaterialGrade(MaterialName(ft.Document, ft.get_Parameter(BuiltInParameter.STRUCTURAL_MATERIAL_PARAM)?.AsElementId()));
            return row;
        },
        e => e is Floor);

    public static ITableExporter RoofType() => new TypeTableExporter("roof_type", Layered,
        [BuiltInCategory.OST_Roofs],
        t => t is RoofType rt ? LayeredRow(rt, rt.GetCompoundStructure(),
            rt.get_Parameter(BuiltInParameter.ROOF_ATTR_DEFAULT_THICKNESS_PARAM)?.AsDouble() is { } th ? M(th) : null) : null);

    public static ITableExporter CeilingType() => new TypeTableExporter("ceiling_type", Layered,
        [BuiltInCategory.OST_Ceilings],
        t =>
        {
            if (t is not CeilingType ct) return null;
            var row = LayeredRow(ct, ct.GetCompoundStructure(), null);
            // A ceiling type without layers needs a thickness (validate); Revit's
            // basic ceilings are a single finish layer, so this rarely triggers.
            row["thickness"] ??= "0.02";
            return row;
        });

    /// <summary>
    /// type_layer rows of every layered type in use (walls, floors, roofs, ceilings).
    /// ApplyTypes drops the layers of types that end up unused.
    /// </summary>
    public static ITableExporter TypeLayer() => new TypeLayerExporter();

    sealed class TypeLayerExporter : ITableExporter
    {
        public string TableName => "type_layer";
        public bool IsGlobal => true;
        public IReadOnlyList<string> Columns { get; } = ["id", "type_id", "seq", "function", "material", "thickness", "conductivity", "name"];
        public IReadOnlyList<string> CsvColumns => Columns;

        public List<Dictionary<string, string?>> Export(Document doc)
        {
            var rows = new List<Dictionary<string, string?>>();
            var types = UsedTypes(doc, [BuiltInCategory.OST_Walls, BuiltInCategory.OST_Floors, BuiltInCategory.OST_Roofs, BuiltInCategory.OST_Ceilings], null);
            foreach (var t in types)
            {
                var cs = t switch
                {
                    WallType { Kind: WallKind.Basic } wt => wt.GetCompoundStructure(),
                    FloorType ft => ft.GetCompoundStructure(),
                    RoofType rt => rt.GetCompoundStructure(),
                    CeilingType ct => ct.GetCompoundStructure(),
                    _ => null,
                };
                if (cs is null) continue;
                rows.AddRange(LayerMapper.LayerRows(t.UniqueId, Layers(doc, cs)));
            }
            return rows;
        }
    }

    static Dictionary<string, string?> FenestrationRow(Element t, bool isDoor)
    {
        var sym = (FamilySymbol)t;
        var w = t.get_Parameter(isDoor ? BuiltInParameter.DOOR_WIDTH : BuiltInParameter.WINDOW_WIDTH).AsPositiveDouble()
             ?? t.get_Parameter(BuiltInParameter.FAMILY_WIDTH_PARAM).AsPositiveDouble()
             ?? t.get_Parameter(BuiltInParameter.FURNITURE_WIDTH).AsPositiveDouble();
        var h = t.get_Parameter(isDoor ? BuiltInParameter.DOOR_HEIGHT : BuiltInParameter.WINDOW_HEIGHT).AsPositiveDouble()
             ?? t.get_Parameter(BuiltInParameter.FAMILY_HEIGHT_PARAM).AsPositiveDouble();
        if (w is null || h is null)
        {
            // Families that size by rough opening or by instance parameters: rough size on the
            // type, else the size of a placed instance (width is required on the type row).
            w ??= t.get_Parameter(BuiltInParameter.FAMILY_ROUGH_WIDTH_PARAM).AsPositiveDouble()
                  ?? Positive(Extractors.ParameterUtils.FindDoubleParameterByNames(t, "Width", "Rough Width", "宽度", "洞口宽度"));
            h ??= t.get_Parameter(BuiltInParameter.FAMILY_ROUGH_HEIGHT_PARAM).AsPositiveDouble()
                  ?? Positive(Extractors.ParameterUtils.FindDoubleParameterByNames(t, "Height", "Rough Height", "高度", "洞口高度"));
            if ((w is null || h is null) && new FilteredElementCollector(t.Document).WherePasses(new FamilyInstanceFilter(t.Document, t.Id)).FirstElement() is { } inst)
            {
                w ??= inst.get_Parameter(isDoor ? BuiltInParameter.DOOR_WIDTH : BuiltInParameter.WINDOW_WIDTH).AsPositiveDouble()
                      ?? inst.get_Parameter(BuiltInParameter.FAMILY_WIDTH_PARAM).AsPositiveDouble()
                      ?? Positive(Extractors.ParameterUtils.FindDoubleParameterByNames(inst, "Width", "Rough Width", "宽度"));
                h ??= inst.get_Parameter(isDoor ? BuiltInParameter.DOOR_HEIGHT : BuiltInParameter.WINDOW_HEIGHT).AsPositiveDouble()
                      ?? inst.get_Parameter(BuiltInParameter.FAMILY_HEIGHT_PARAM).AsPositiveDouble()
                      ?? Positive(Extractors.ParameterUtils.FindDoubleParameterByNames(inst, "Height", "Rough Height", "高度"));
            }
        }
        var explicitOp = Extractors.ParameterUtils.FindStringParameterByNames(t, "Operation", "Swing", "操作", "开启", "开启方式");
        var frame = Extractors.ParameterUtils.FindDoubleParameterByNames(t, "Frame Width", "Frame width", "框宽", "门框宽度", "窗框宽度");
        return new Dictionary<string, string?>
        {
            ["description"] = Description(t),
            ["material"] = MaterialMapper.MapToEnum(MaterialName(t.Document, t.get_Parameter(isDoor ? BuiltInParameter.DOOR_FRAME_MATERIAL : BuiltInParameter.MATERIAL_ID_PARAM)?.AsElementId())
                ?? FirstMaterialName(t)),
            ["width"] = Names.Num(w is { } wv ? M(wv) : null, 3),
            ["height"] = Names.Num(h is { } hv ? M(hv) : null, 3),
            ["operation"] = isDoor
                ? OpeningMapper.DoorOperation(explicitOp, sym.FamilyName, sym.Name)
                : OpeningMapper.WindowOperation(explicitOp, sym.FamilyName, sym.Name),
            ["frame_width"] = frame is > 0 ? Names.Num(M(frame.Value), 3) : null,
            ["u_value"] = Names.Num(FromInternal(t.get_Parameter(BuiltInParameter.ANALYTICAL_HEAT_TRANSFER_COEFFICIENT), UnitTypeId.WattsPerSquareMeterKelvin), 3),
            ["shgc"] = Names.Num(Fraction(t.get_Parameter(BuiltInParameter.ANALYTICAL_SOLAR_HEAT_GAIN_COEFFICIENT)), 3),
            ["vt"] = Names.Num(Fraction(t.get_Parameter(BuiltInParameter.ANALYTICAL_VISUAL_LIGHT_TRANSMITTANCE)), 3),
        };
    }

    static double? Positive(double? v) => v is > 0 ? v : null;

    static double? Fraction(Parameter? p)
    {
        if (p is null || !p.HasValue || p.StorageType != StorageType.Double) return null;
        var v = p.AsDouble();
        return v is > 0 and <= 1 ? v : null;
    }

    static string? FirstMaterialName(Element e)
    {
        foreach (Parameter p in e.Parameters)
        {
            try
            {
                if (p.StorageType == StorageType.ElementId && p.Definition.GetDataType() == SpecTypeId.Reference.Material
                    && MaterialName(e.Document, p.AsElementId()) is { } n)
                    return n;
            }
            catch { }
        }
        return null;
    }

    public static ITableExporter DoorType() => new TypeTableExporter("door_type", Fenestration,
        [BuiltInCategory.OST_Doors], t => t is FamilySymbol ? FenestrationRow(t, true) : null,
        e => !ArchitectureTableExporters.IsCurtainPanel(e));

    public static ITableExporter WindowType() => new TypeTableExporter("window_type", Fenestration,
        [BuiltInCategory.OST_Windows], t => t is FamilySymbol ? FenestrationRow(t, false) : null,
        e => !ArchitectureTableExporters.IsCurtainPanel(e));

    public static ITableExporter CurtainWallType() => new TypeTableExporter("curtain_wall_type",
        ["id", "name", "description", "material", "u_spacing", "v_spacing", "panel_material", "solid_material",
         "mullion_width", "mullion_depth", "mullion_profile", "u_value", "shgc", "vt"],
        [BuiltInCategory.OST_Walls],
        t =>
        {
            if (t is not WallType { Kind: WallKind.Curtain } wt) return null;
            var doc = wt.Document;
            var row = new Dictionary<string, string?> { ["description"] = Description(wt) };
            // Vertical grid lines repeat along the wall (v_spacing), horizontal ones up it (u_spacing).
            row["v_spacing"] = FixedSpacing(wt, BuiltInParameter.SPACING_LAYOUT_VERT, BuiltInParameter.SPACING_LENGTH_VERT);
            row["u_spacing"] = FixedSpacing(wt, BuiltInParameter.SPACING_LAYOUT_HORIZ, BuiltInParameter.SPACING_LENGTH_HORIZ);
            if (doc.GetElement(wt.get_Parameter(BuiltInParameter.AUTO_MULLION_INTERIOR_VERT)?.AsElementId() ?? ElementId.InvalidElementId) is MullionType mt)
            {
                var radius = mt.get_Parameter(BuiltInParameter.CIRC_MULLION_RADIUS).AsPositiveDouble();
                if (radius is { } r)
                {
                    row["mullion_profile"] = "round";
                    row["mullion_width"] = Names.Num(M(2 * r), 3);
                    row["mullion_depth"] = Names.Num(M(2 * r), 3);
                }
                else
                {
                    var w1 = mt.get_Parameter(BuiltInParameter.RECT_MULLION_WIDTH1)?.AsDouble() ?? 0;
                    var w2 = mt.get_Parameter(BuiltInParameter.RECT_MULLION_WIDTH2)?.AsDouble() ?? 0;
                    var thick = mt.get_Parameter(BuiltInParameter.RECT_MULLION_THICK)?.AsDouble() ?? 0;
                    if (w1 + w2 > 0) row["mullion_width"] = Names.Num(M(w1 + w2), 3);
                    if (thick > 0) row["mullion_depth"] = Names.Num(M(thick), 3);
                    row["mullion_profile"] = w1 + w2 > 0 ? "rect" : null;
                }
                row["material"] = MaterialMapper.MapToEnum(MaterialName(doc, mt.get_Parameter(BuiltInParameter.MATERIAL_ID_PARAM)?.AsElementId()) ?? "aluminum");
            }
            else row["material"] = "aluminum";
            var panel = doc.GetElement(wt.get_Parameter(BuiltInParameter.AUTO_PANEL_WALL)?.AsElementId() ?? ElementId.InvalidElementId);
            if (panel is not null)
            {
                var mat = MaterialName(doc, panel.get_Parameter(BuiltInParameter.MATERIAL_ID_PARAM)?.AsElementId()) ?? FirstMaterialName(panel);
                row["panel_material"] = mat is null ? "glass" : MaterialMapper.MapToEnum(mat);
                row["u_value"] = Names.Num(FromInternal(panel.get_Parameter(BuiltInParameter.ANALYTICAL_HEAT_TRANSFER_COEFFICIENT), UnitTypeId.WattsPerSquareMeterKelvin), 3);
                row["shgc"] = Names.Num(Fraction(panel.get_Parameter(BuiltInParameter.ANALYTICAL_SOLAR_HEAT_GAIN_COEFFICIENT)), 3);
                row["vt"] = Names.Num(Fraction(panel.get_Parameter(BuiltInParameter.ANALYTICAL_VISUAL_LIGHT_TRANSMITTANCE)), 3);
            }
            return row;
        },
        e => e is Wall { WallType.Kind: WallKind.Curtain });

    static string? FixedSpacing(Element t, BuiltInParameter layout, BuiltInParameter length)
    {
        // Layout 1 = fixed distance, 3 = maximum spacing: a line every `length`.
        var l = t.get_Parameter(layout)?.AsInteger();
        if (l is not (1 or 3)) return null;
        var v = t.get_Parameter(length).AsPositiveDouble();
        return v is { } s ? Names.Num(M(s), 3) : null;
    }

    static Dictionary<string, string?> SectionRow(Element t, bool architectural)
    {
        var sym = (FamilySymbol)t;
        var f = SectionMapper.Map(Section(sym));
        if (architectural) f = SectionMapper.ToArchitectural(f);
        var matName = MaterialName(t.Document, t.get_Parameter(BuiltInParameter.STRUCTURAL_MATERIAL_PARAM)?.AsElementId())
                      ?? FirstMaterialName(t);
        f["description"] = Description(t);
        f["material"] = matName is null ? null : MaterialMapper.MapToEnum(matName);
        if (!architectural) f["material_grade"] = MaterialMapper.MaterialGrade(matName);
        return f;
    }

    public static ITableExporter ColumnType() => new TypeTableExporter("column_type", Section,
        [BuiltInCategory.OST_Columns, BuiltInCategory.OST_StructuralColumns],
        t => t is FamilySymbol fs ? SectionRow(t, fs.Category?.BuiltInCategory == BuiltInCategory.OST_Columns) : null);

    public static ITableExporter BeamType() => new TypeTableExporter("beam_type", Section,
        [BuiltInCategory.OST_StructuralFraming],
        t => t is FamilySymbol ? SectionRow(t, false) : null);

    public static ITableExporter FoundationType() => new TypeTableExporter("foundation_type",
        ["id", "name", "description", "material", "kind", "width", "length", "thickness", "material_grade"],
        [BuiltInCategory.OST_StructuralFoundation],
        t =>
        {
            var doc = t.Document;
            var matName = MaterialName(doc, t.get_Parameter(BuiltInParameter.STRUCTURAL_MATERIAL_PARAM)?.AsElementId()) ?? FirstMaterialName(t);
            var row = new Dictionary<string, string?>
            {
                ["description"] = Description(t),
                ["material"] = matName is null ? "concrete" : MaterialMapper.MapToEnum(matName),
                ["material_grade"] = MaterialMapper.MaterialGrade(matName),
            };
            switch (t)
            {
                case FloorType ft:
                    row["kind"] = "raft";
                    row["thickness"] = Names.Num(LayerMapper.TotalThickness(Layers(doc, ft.GetCompoundStructure())) is > 0 and var th ? th : null, 3);
                    break;
                case WallFoundationType:
                    row["kind"] = "strip";
                    row["width"] = Names.Num(t.get_Parameter(BuiltInParameter.CONTINUOUS_FOOTING_WIDTH).AsPositiveDouble() is { } w ? M(w) : null, 3);
                    row["thickness"] = Names.Num(t.get_Parameter(BuiltInParameter.STRUCTURAL_FOUNDATION_THICKNESS).AsPositiveDouble() is { } d ? M(d) : null, 3);
                    break;
                case FamilySymbol fs:
                    var kind = FoundationMapper.Kind("FamilyInstance", fs.FamilyName, fs.Name);
                    row["kind"] = kind;
                    var p = LengthParams(fs);
                    double? Get(params string[] n) { foreach (var k in n) if (p.TryGetValue(k, out var v) && v > 0) return v; return null; }
                    var width = t.get_Parameter(BuiltInParameter.STRUCTURAL_FOUNDATION_WIDTH).AsPositiveDouble() is { } fw ? M(fw)
                        : Get("width", "diameter", "pile diameter", "d", "b", "宽度", "直径");
                    var length = t.get_Parameter(BuiltInParameter.STRUCTURAL_FOUNDATION_LENGTH).AsPositiveDouble() is { } fl ? M(fl)
                        : Get("length", "l", "长度");
                    var thick = t.get_Parameter(BuiltInParameter.STRUCTURAL_FOUNDATION_THICKNESS).AsPositiveDouble() is { } ft2 ? M(ft2)
                        : kind == "pile" ? Get("pile length", "length", "桩长") : Get("thickness", "foundation thickness", "h", "厚度");
                    row["width"] = Names.Num(width, 3);
                    row["length"] = kind == "pile" && Math.Abs((length ?? 0) - (thick ?? -1)) < 1e-6 ? null : Names.Num(length, 3);
                    row["thickness"] = Names.Num(thick, 3);
                    break;
                default:
                    return null;
            }
            return row;
        });

    public static ITableExporter FurnitureType() => new TypeTableExporter("furniture_type",
        ["id", "name", "description", "family", "variant", "size_x", "size_y", "height"],
        FurnitureCategories,
        t =>
        {
            if (t is not FamilySymbol fs) return null;
            var guess = FurnitureMapper.Guess(fs.FamilyName, fs.Name, fs.Category?.Name);
            var row = new Dictionary<string, string?>
            {
                ["description"] = Description(t),
                ["family"] = guess.Family,
                ["variant"] = guess.Variant,
            };
            if (fs.get_BoundingBox(null) is { } bb)
            {
                row["size_x"] = Names.Num(M(bb.Max.X - bb.Min.X), 3);
                row["size_y"] = Names.Num(M(bb.Max.Y - bb.Min.Y), 3);
                row["height"] = Names.Num(M(bb.Max.Z - bb.Min.Z), 3);
            }
            return row;
        },
        ArchitectureTableExporters.IsFurniture);

    public static ITableExporter RailingType() => new TypeTableExporter("railing_type",
        ["id", "name", "description", "material", "height", "top_rail_shape", "top_rail_size", "infill", "baluster_spacing", "baluster_size"],
        [BuiltInCategory.OST_StairsRailing],
        t =>
        {
            if (t is not RailingType rt) return null;
            var doc = rt.Document;
            string? profileName = null;
            double? railSize = null;
            string? material = null;
            if (doc.GetElement(rt.TopRailType) is TopRailType trt)
            {
                var profile = doc.GetElement(trt.ProfileId) as FamilySymbol;
                profileName = profile is null ? trt.Name : $"{profile.FamilyName} {profile.Name}";
                var pp = LengthParams(profile);
                railSize = pp.TryGetValue("diameter", out var dia) ? dia : pp.TryGetValue("width", out var pw) ? pw : null;
                material = MaterialName(doc, trt.get_Parameter(BuiltInParameter.MATERIAL_ID_PARAM)?.AsElementId());
            }
            var balusterNames = new List<string>();
            var gaps = new List<double>();
            double? balusterSize = null;
            try
            {
                var pattern = rt.BalusterPlacement?.BalusterPattern;
                if (pattern is not null)
                {
                    for (var i = 0; i < pattern.GetBalusterCount(); i++)
                    {
                        var b = pattern.GetBaluster(i);
                        if (doc.GetElement(b.BalusterFamilyId) is FamilySymbol bs)
                        {
                            balusterNames.Add($"{bs.FamilyName} {bs.Name}");
                            var bp = LengthParams(bs);
                            balusterSize ??= bp.TryGetValue("width", out var bw) ? bw : bp.TryGetValue("diameter", out var bd) ? bd : null;
                            material ??= MaterialName(doc, bs.get_Parameter(BuiltInParameter.MATERIAL_ID_PARAM)?.AsElementId());
                        }
                        if (b.DistanceFromPreviousOrSpace > 0) gaps.Add(M(b.DistanceFromPreviousOrSpace));
                    }
                }
            }
            catch { }
            var row = RailingMapper.TypeFields(new RailingTypeInput(rt.Name, rt.TopRailHeight > 0 ? M(rt.TopRailHeight) : null,
                profileName, railSize, balusterNames, gaps.Count > 0 ? gaps.Average() : null, balusterSize, material));
            row["description"] = Description(rt);
            return row;
        });

    /// <summary>Type exporters serving the enabled instance tables.</summary>
    public static ITableExporter[] ForEnabled(ISet<string> enabled)
    {
        var list = new List<ITableExporter>();
        bool Any(params string[] t) => t.Any(enabled.Contains);
        if (Any("wall", "structure_wall")) list.Add(WallType());
        if (Any("slab", "structure_slab")) list.Add(SlabType());
        if (Any("roof")) list.Add(RoofType());
        if (Any("ceiling")) list.Add(CeilingType());
        if (Any("wall", "structure_wall", "slab", "structure_slab", "roof", "ceiling")) list.Add(TypeLayer());
        if (Any("door")) list.Add(DoorType());
        if (Any("window")) list.Add(WindowType());
        if (Any("curtain_wall")) list.Add(CurtainWallType());
        if (Any("column", "structure_column")) list.Add(ColumnType());
        if (Any("beam", "brace", "beam_system")) list.Add(BeamType());
        if (Any("foundation")) list.Add(FoundationType());
        if (Any("furniture")) list.Add(FurnitureType());
        if (Any("railing")) list.Add(RailingType());
        return [.. list];
    }
}
