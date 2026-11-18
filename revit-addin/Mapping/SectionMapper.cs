using System.Text.RegularExpressions;

namespace BimDown.RevitAddin.Mapping;

/// <summary>
/// Cross-section data read from a Revit structural family type, already in
/// meters. Filled from the StructuralSection API when the family has one
/// (<see cref="ShapeName"/> = StructuralSectionShape name), plus the family's
/// own dimension parameters (<see cref="Params"/>, lower-cased names → meters).
/// </summary>
public record SectionInput
{
    public string? ShapeName { get; init; }
    public string FamilyName { get; init; } = "";
    public string TypeName { get; init; } = "";
    public string? NameKey { get; init; }
    public double? Width { get; init; }
    public double? Height { get; init; }
    public double? Diameter { get; init; }
    public double? FlangeThickness { get; init; }
    public double? WebThickness { get; init; }
    public double? WebFillet { get; init; }
    public double? WallThickness { get; init; }
    public double? OuterFillet { get; init; }
    public IReadOnlyDictionary<string, double> Params { get; init; } = new Dictionary<string, double>();
}

/// <summary>
/// Revit framing / column family type → BimDown <c>structural_section_profile</c>
/// fields (shape, size_x, size_y, flange, web, thickness, root_radius, designation).
/// </summary>
public static partial class SectionMapper
{
    // Sanity limit: some families store the member length in their "width" parameter.
    const double MaxSectionSize = 10.0;

    /// <summary>StructuralSectionShape enum name → BimDown shape (null = not decided).</summary>
    public static string? ShapeFromSectionShape(string? shapeName) => shapeName switch
    {
        null or "" or "NotDefined" or "Invalid" or "UserDefined" => null,
        "IWideFlange" or "IParallelFlange" or "ISlopedFlange" or "IWelded" or "ISplitParallelFlange" or "ISplitSlopedFlange" => "i_shape",
        "StructuralTees" or "ConcreteT" => "t_shape",
        "LAngle" or "LProfile" or "LProfileWithLips" => "l_shape",
        "CParallelFlange" or "CSlopedFlange" or "CProfile" or "CProfileWithLips" or "CProfileWithFold" => "c_shape",
        "RectangleHSS" => "rect_hollow",
        "RoundHSS" or "PipeStandard" => "round_hollow",
        "RoundBar" or "ConcreteRound" => "round",
        "RectangularBar" or "ConcreteRectangle" or "ConcreteRectangleCut" or "RectangleParameterized" => "rect",
        "ConcreteCross" => "cross",
        _ => null,
    };

    [GeneratedRegex(@"^\d{1,3}\s*(K|KCS|LH|DLH)\s*\d{1,4}$", RegexOptions.IgnoreCase)]
    private static partial Regex JoistDesignationRegex();

    /// <summary>Shape from family / type naming (English and Chinese), null when the name says nothing.</summary>
    public static string? ShapeFromName(string familyName, string typeName)
    {
        var f = $"{familyName} {typeName}".ToLowerInvariant();
        if (JoistDesignationRegex().IsMatch(typeName.Trim()) || Names.ContainsAny(f, "bar joist", "open web", "k-series", "lh-series", "桁架梁"))
            return "open_web";
        if (Names.ContainsAny(f, "hss", "rhs", "shs", "hollow", "tube", "box", "方管", "矩形管", "箱形"))
            return Names.ContainsAny(f, "round", "chs", "pipe", "圆管") ? "round_hollow" : "rect_hollow";
        if (Names.ContainsAny(f, "chs", "pipe", "圆管", "钢管")) return "round_hollow";
        if (Names.ContainsAny(f, "wide flange", "w-shape", "w shape", "i-beam", "i beam", "universal beam", "universal column", "工字", "h型钢", "h-section")
            || Regex.IsMatch(typeName, @"^\s*(W|HP|S|M)\s*\d+\s*[Xx×]\s*\d", RegexOptions.IgnoreCase)
            || Regex.IsMatch(typeName, @"^\s*(HE[ABM]?|HE\s?[ABM]|IPE|IPN|UB|UC|HN|HW|HM|HP)\s*\d", RegexOptions.IgnoreCase))
            return "i_shape";
        if (Names.ContainsAny(f, "channel", "c-shape", "pfc", "槽钢") || Regex.IsMatch(typeName, @"^\s*(C|MC|UPN|UPE|PFC)\s*\d", RegexOptions.IgnoreCase))
            return "c_shape";
        if (Names.ContainsAny(f, "angle", "l-shape", "角钢") || Regex.IsMatch(typeName, @"^\s*L\s*\d+\s*[Xx×]", RegexOptions.IgnoreCase))
            return "l_shape";
        if (Names.ContainsAny(f, "tee", "t-shape", "t型钢") || Regex.IsMatch(typeName, @"^\s*(WT|MT|ST)\s*\d", RegexOptions.IgnoreCase))
            return "t_shape";
        if (Names.ContainsAny(f, "cruciform", "cross", "十字")) return "cross";
        if (Names.ContainsAny(f, "round", "circular", "圆")) return "round";
        if (Names.ContainsAny(f, "rectangular", "rectangle", "square", "矩形", "方形")) return "rect";
        return null;
    }

    [GeneratedRegex(@"^\s*(W\s?\d+\s?[Xx]\s?\d+(\.\d+)?|HP\s?\d+\s?[Xx]\s?\d+|M\s?\d+\s?[Xx]\s?\d+(\.\d+)?|S\s?\d+\s?[Xx]\s?\d+(\.\d+)?|C\s?\d+\s?[Xx]\s?\d+(\.\d+)?|MC\s?\d+\s?[Xx]\s?\d+(\.\d+)?|WT\s?\d+(\.\d+)?\s?[Xx]\s?\d+(\.\d+)?|L\s?\d+(-\d/\d)?\s?[Xx]\s?\d+.*|HSS\s?[\d./]+\s?[Xx]\s?[\d./]+.*|HE\s?\d+\s?[ABM]|HE[ABM]\s?\d+|IPE\s?\d+|IPN\s?\d+|UPN\s?\d+|UPE\s?\d+|UB\s?\d+.*|UC\s?\d+.*|PFC\s?\d+.*|CHS\s?[\d.]+\s?[Xx]\s?[\d.]+|RHS\s?[\d.]+.*|SHS\s?[\d.]+.*|H[NWM]\s?\d+.*|\d{1,3}\s?(K|KCS|LH|DLH)\s?\d{1,4})\s*$", RegexOptions.IgnoreCase)]
    private static partial Regex CatalogueRegex();

    /// <summary>
    /// Catalogue designation: the StructuralSection name key when set, else the
    /// type name when it reads like a catalogue section (W14X90, HEA 300, HSS8X8X1/2, 14K1).
    /// </summary>
    public static string? Designation(string? nameKey, string typeName)
    {
        if (!string.IsNullOrWhiteSpace(nameKey) && CatalogueRegex().IsMatch(nameKey)) return nameKey.Trim();
        if (CatalogueRegex().IsMatch(typeName)) return typeName.Trim();
        return string.IsNullOrWhiteSpace(nameKey) ? null : nameKey.Trim();
    }

    static double? P(SectionInput s, params string[] names)
    {
        foreach (var n in names)
            if (s.Params.TryGetValue(n.ToLowerInvariant(), out var v) && v > 0) return v;
        return null;
    }

    static double? Sane(double? v) => v is > 0 and <= MaxSectionSize ? v : null;

    /// <summary>
    /// Section fields for a type. Missing dimensions stay empty (tools fall back to
    /// proportions); shape is always set (rect when nothing is known).
    /// </summary>
    public static Dictionary<string, string?> Map(SectionInput s)
    {
        var shape = ShapeFromSectionShape(s.ShapeName) ?? ShapeFromName(s.FamilyName, s.TypeName);

        // Section API values first, then the usual family parameter names
        // (AISC: bf d tf tw k / Ht B t; EU: b h tf tw r; concrete: b h; round: d / OD).
        var width = Sane(s.Width ?? P(s, "bf", "b", "width", "flange width", "宽度", "宽", "截面宽度"));
        var height = Sane(s.Height ?? P(s, "d", "h", "ht", "depth", "height", "高度", "高", "截面高度"));
        var diameter = Sane(s.Diameter ?? P(s, "od", "diameter", "d", "直径", "外径"));
        var flange = Sane(s.FlangeThickness ?? P(s, "tf", "flange thickness", "翼缘厚度"));
        var web = Sane(s.WebThickness ?? P(s, "tw", "web thickness", "腹板厚度"));
        var wall = Sane(s.WallThickness ?? P(s, "tdes", "tnom", "t", "wall thickness", "壁厚"));
        var root = Sane(s.WebFillet ?? s.OuterFillet ?? P(s, "r", "r1", "k1", "root radius", "fillet radius", "圆角半径"));

        if (shape is null)
        {
            if (s.Diameter is > 0 && s.Width is null) shape = "round";
            else if (flange is not null && web is not null) shape = "i_shape";
            else shape = "rect";
        }

        var f = new Dictionary<string, string?> { ["shape"] = shape };
        switch (shape)
        {
            case "round":
                f["size_x"] = Names.Num(diameter ?? width, 4);
                break;
            case "round_hollow":
                f["size_x"] = Names.Num(diameter ?? width, 4);
                f["thickness"] = Names.Num(wall, 4);
                break;
            case "rect_hollow":
                f["size_x"] = Names.Num(width, 4);
                f["size_y"] = Names.Num(height ?? width, 4);
                f["thickness"] = Names.Num(wall, 4);
                f["root_radius"] = Names.Num(s.OuterFillet ?? root, 4);
                break;
            case "i_shape" or "c_shape" or "t_shape":
                f["size_x"] = Names.Num(width, 4);
                f["size_y"] = Names.Num(height, 4);
                f["flange"] = Names.Num(flange, 4);
                f["web"] = Names.Num(web, 4);
                f["root_radius"] = Names.Num(root, 4);
                break;
            case "l_shape":
                f["size_x"] = Names.Num(width, 4);
                f["size_y"] = Names.Num(height ?? width, 4);
                f["thickness"] = Names.Num(wall ?? flange ?? web, 4);
                f["root_radius"] = Names.Num(root, 4);
                break;
            case "cross":
                f["size_x"] = Names.Num(width, 4);
                f["size_y"] = Names.Num(height ?? width, 4);
                f["thickness"] = Names.Num(wall ?? web, 4);
                break;
            case "open_web":
                f["size_x"] = Names.Num(width, 4);
                f["size_y"] = Names.Num(height, 4);
                f["flange"] = Names.Num(flange, 4);
                f["thickness"] = Names.Num(wall, 4);
                break;
            default:
                f["size_x"] = Names.Num(width, 4);
                f["size_y"] = Names.Num(height, 4);
                break;
        }

        f["designation"] = Designation(s.NameKey, s.TypeName);
        return f;
    }

    /// <summary>
    /// An architectural column takes only rect / round (<c>section_profile</c>):
    /// hollow and steel shapes collapse to their outline.
    /// </summary>
    public static Dictionary<string, string?> ToArchitectural(Dictionary<string, string?> structural)
    {
        var shape = structural.GetValueOrDefault("shape");
        var round = shape is "round" or "round_hollow";
        var sx = structural.GetValueOrDefault("size_x");
        return new Dictionary<string, string?>
        {
            ["shape"] = round ? "round" : "rect",
            ["size_x"] = sx,
            ["size_y"] = round ? null : structural.GetValueOrDefault("size_y") ?? sx,
        };
    }
}
