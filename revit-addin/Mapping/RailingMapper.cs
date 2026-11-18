namespace BimDown.RevitAddin.Mapping;

/// <summary>Railing type data read from a Revit RailingType, lengths in meters.</summary>
public record RailingTypeInput(
    string Name,
    double? TopRailHeight,
    string? TopRailProfileName,
    double? TopRailSize,
    IReadOnlyList<string> BalusterFamilyNames,
    double? BalusterSpacing,
    double? BalusterSize,
    string? MaterialName);

public static class RailingMapper
{
    /// <summary>railing_type row fields (without id).</summary>
    public static Dictionary<string, string?> TypeFields(RailingTypeInput t)
    {
        var balusters = t.BalusterFamilyNames.Where(n => !string.IsNullOrWhiteSpace(n)).ToList();
        string infill;
        if (balusters.Any(n => Names.ContainsAny(n, "panel", "glass", "glazed", "玻璃", "嵌板"))) infill = "glass";
        else if (balusters.Count == 0 || balusters.All(n => Names.ContainsAny(n, "none", "无"))) infill = "none";
        else infill = "balusters";

        string? railShape = t.TopRailProfileName is null ? null
            : Names.ContainsAny(t.TopRailProfileName, "rect", "square", "矩形", "方") ? "rect"
            : Names.ContainsAny(t.TopRailProfileName, "round", "circular", "pipe", "圆") ? "round"
            : null;

        return new Dictionary<string, string?>
        {
            ["name"] = t.Name,
            ["height"] = t.TopRailHeight is > 0 ? Names.Num(t.TopRailHeight.Value, 3) : null,
            ["top_rail_shape"] = railShape,
            ["top_rail_size"] = t.TopRailSize is > 0 and < 0.5 ? Names.Num(t.TopRailSize.Value, 3) : null,
            ["infill"] = infill,
            ["baluster_spacing"] = infill == "balusters" && t.BalusterSpacing is > 0.01 and < 5 ? Names.Num(t.BalusterSpacing.Value, 3) : null,
            ["baluster_size"] = infill == "balusters" && t.BalusterSize is > 0 and < 0.5 ? Names.Num(t.BalusterSize.Value, 3) : null,
            ["material"] = string.IsNullOrWhiteSpace(t.MaterialName) ? null : MaterialMapper.MapToEnum(t.MaterialName),
        };
    }
}
