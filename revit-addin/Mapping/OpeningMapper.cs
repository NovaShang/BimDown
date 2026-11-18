namespace BimDown.RevitAddin.Mapping;

/// <summary>Door / window operation from an explicit "Operation" parameter or the family / type names.</summary>
public static class OpeningMapper
{
    public static string? DoorOperation(string? explicitOperation, string familyName, string typeName)
    {
        foreach (var text in new[] { explicitOperation, $"{familyName} {typeName}" })
        {
            if (string.IsNullOrWhiteSpace(text)) continue;
            if (Names.ContainsAny(text, "revolving", "旋转")) return "revolving";
            if (Names.ContainsAny(text, "folding", "bifold", "bi-fold", "折叠")) return "folding";
            if (Names.ContainsAny(text, "sliding", "slider", "pocket", "推拉")) return "sliding";
            if (Names.ContainsAny(text, "double", "pair", "双开", "双扇", "双门", "对开")) return "double_swing";
            if (Names.ContainsAny(text, "single", "单开", "单扇", "单门", "hinged", "swing", "平开")) return "single_swing";
        }
        return null;
    }

    public static string? WindowOperation(string? explicitOperation, string familyName, string typeName)
    {
        if (!string.IsNullOrWhiteSpace(explicitOperation) && Normalize(explicitOperation) is { } n) return n;
        var name = $"{familyName} {typeName}".ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(name)) return null;
        if (name.Contains("tilt") && name.Contains("turn") || name.Contains("内开内倒")) return "tilt_and_turn";
        if (Names.ContainsAny(name, "double hung", "double_hung", "double-hung", "上下推拉")) return "double_hung";
        if (Names.ContainsAny(name, "single hung", "single_hung", "single-hung")) return "single_hung";
        if (Names.ContainsAny(name, "fixed", "固定")) return "fixed";
        if (Names.ContainsAny(name, "casement", "平开")) return "casement";
        if (Names.ContainsAny(name, "sliding", "slider", "推拉")) return "sliding";
        if (Names.ContainsAny(name, "awning", "上悬")) return "awning";
        if (Names.ContainsAny(name, "hopper", "下悬")) return "hopper";
        if (Names.ContainsAny(name, "pivot", "中悬")) return "pivot";
        return null;
    }

    static string? Normalize(string raw)
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
}
