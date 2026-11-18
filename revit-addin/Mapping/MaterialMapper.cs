using System.Text.RegularExpressions;

namespace BimDown.RevitAddin.Mapping;

/// <summary>Revit material names → BimDown material enums and strength grades.</summary>
public static partial class MaterialMapper
{
    /// <summary>
    /// Revit material name → the 15-value <c>materialized.material</c> enum
    /// (English and Chinese names). Unknown / empty → composite.
    /// </summary>
    public static string MapToEnum(string? rawName)
    {
        if (string.IsNullOrWhiteSpace(rawName)) return "composite";
        var n = rawName.ToLowerInvariant();

        if (Regex.IsMatch(n, @"\b(eps|xps|pir|pur)\b") || Names.ContainsAny(n, "insulation", "polystyrene", "glass wool", "mineral wool", "rock wool", "polyurethane", "pir board", "保温", "岩棉", "聚苯", "挤塑")) return "insulation";
        if (Names.ContainsAny(n, "concrete", "混凝土", "砼")) return "concrete";
        if (Names.ContainsAny(n, "aluminum", "aluminium", "铝")) return "aluminum";
        if (Names.ContainsAny(n, "copper", "铜")) return "copper";
        if (Names.ContainsAny(n, "steel", "metal", "iron", "钢", "金属", "铁")) return "steel";
        if (n.Contains("clt") || (n.Contains("cross") && n.Contains("laminated")) || n.Contains("交错层积")) return "clt";
        if (Names.ContainsAny(n, "wood", "lumber", "timber", "plywood", "glulam", "oak", "pine", "木")) return "wood";
        if (Names.ContainsAny(n, "glass", "glazing", "玻璃")) return "glass";
        if (Names.ContainsAny(n, "brick", "masonry", "cmu", "block", "砖", "砌块")) return "brick";
        if (Names.ContainsAny(n, "gypsum", "plasterboard", "drywall", "plaster", "石膏")) return "gypsum";
        if (Names.ContainsAny(n, "stone", "granite", "marble", "石材", "花岗", "大理石")) return "stone";
        if (Names.ContainsAny(n, "pvc", "plastic", "vinyl", "塑料")) return "pvc";
        if (Names.ContainsAny(n, "ceramic", "tile", "porcelain", "陶瓷", "瓷砖")) return "ceramic";
        if (Names.ContainsAny(n, "fiber cement", "fibre cement", "fiber_cement", "cement board", "纤维水泥")) return "fiber_cement";

        return "composite";
    }

    /// <summary>
    /// Pipe segment / material name → <c>pipe.material</c> enum, or null when unknown.
    /// Order matters: "stainless steel" and "galvanized steel" before plain steel, CPVC → pvc.
    /// </summary>
    public static string? PipeMaterial(string? rawName)
    {
        if (string.IsNullOrWhiteSpace(rawName)) return null;
        var n = rawName.ToLowerInvariant();
        if (Names.ContainsAny(n, "stainless", "不锈钢")) return "stainless_steel";
        if (Names.ContainsAny(n, "galvan", "镀锌")) return "galvanized_steel";
        if (Names.ContainsAny(n, "ductile", "球墨")) return "ductile_iron";
        if (Names.ContainsAny(n, "cast iron", "铸铁")) return "cast_iron";
        if (Names.ContainsAny(n, "copper", "铜")) return "copper";
        if (Names.ContainsAny(n, "pp-r", "ppr", "polypropylene")) return "ppr";
        if (Names.ContainsAny(n, "hdpe", "pe100", "pe80", "polyethylene")) return n.Contains("pex") ? "pex" : "hdpe";
        if (Names.ContainsAny(n, "pex")) return "pex";
        if (Names.ContainsAny(n, "pvc", "upvc", "abs", "塑料")) return "pvc";
        if (Names.ContainsAny(n, "steel", "carbon", "钢")) return "steel";
        return null;
    }

    [GeneratedRegex(@"\b(LC\d{2}/\d{2}|C\d{2,3}/\d{2,3}|C\d{2,3}|Q\d{3}[A-E]?|S\d{3}[A-Z0-9]*|GL\d{2}[hc]|A\d{3,4}(?:\s+Gr(?:ade)?\.?\s*\d+)?|HRB\d{3}|D\d{2}|[1-9]\d?ksi|f'?c\s*=?\s*\d+(?:\.\d+)?\s*(?:MPa|ksi))", RegexOptions.IgnoreCase)]
    private static partial Regex GradeRegex();

    /// <summary>
    /// Strength grade from a structural material name: "Concrete, C30/37" → "C30/37",
    /// "Steel ASTM A992" → "A992", "Q355B" → "Q355B", "S355JR" → "S355JR",
    /// "Glulam GL24h" → "GL24h", "C30 混凝土" → "C30". Null when none is named.
    /// </summary>
    public static string? MaterialGrade(string? materialName)
    {
        if (string.IsNullOrWhiteSpace(materialName)) return null;
        var m = GradeRegex().Match(materialName);
        if (!m.Success) return null;
        var g = m.Value.Trim();
        // Normalise case: grades are upper case except the timber class suffix (GL24h).
        if (g.StartsWith("gl", StringComparison.OrdinalIgnoreCase))
            return "GL" + g[2..^1] + char.ToLowerInvariant(g[^1]);
        return g.ToUpperInvariant().Replace("GRADE", "Grade").Replace("GR.", "Gr.");
    }
}
