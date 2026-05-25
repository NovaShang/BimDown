using Autodesk.Revit.DB;

namespace BimDown.RevitAddin.Extractors;

public class StructuralSectionProfileExtractor : IFieldExtractor
{
    public IReadOnlyList<string> FieldNames { get; } = ["shape", "size_x", "size_y"];

    public Dictionary<string, string?> Extract(Element element)
    {
        var fields = new Dictionary<string, string?>();

        // Read shape from STRUCTURAL_SECTION_SHAPE parameter (string)
        var shapeParam = element.get_Parameter(BuiltInParameter.STRUCTURAL_SECTION_SHAPE);
        var shapeStr = shapeParam?.AsString();
        if (!string.IsNullOrEmpty(shapeStr))
        {
            fields["shape"] = MapShape(shapeStr);
        }

        // Try diameter first (round sections)
        var diameter = element.get_Parameter(BuiltInParameter.STRUCTURAL_SECTION_COMMON_DIAMETER).AsPositiveDouble()
                    ?? ParameterUtils.FindDoubleParameterByNames(element, "diameter", "d", "直径");
        if (diameter is { } d && d > 0)
        {
            fields.TryAdd("shape", "round");
            fields["size_x"] = UnitConverter.FormatDouble(UnitConverter.Length(d));
            fields["size_y"] = UnitConverter.FormatDouble(UnitConverter.Length(d));
            return fields;
        }

        // Rectangular / other sections
        var width = element.get_Parameter(BuiltInParameter.STRUCTURAL_SECTION_COMMON_WIDTH).AsPositiveDouble()
                 ?? element.get_Parameter(BuiltInParameter.FAMILY_WIDTH_PARAM).AsPositiveDouble()
                 ?? ParameterUtils.FindDoubleParameterByNames(element, "width", "w", "b", "宽");
        var height = element.get_Parameter(BuiltInParameter.STRUCTURAL_SECTION_COMMON_HEIGHT).AsPositiveDouble()
                  ?? element.get_Parameter(BuiltInParameter.FAMILY_HEIGHT_PARAM).AsPositiveDouble()
                  ?? ParameterUtils.FindDoubleParameterByNames(element, "height", "depth", "h", "d", "高", "深");
        if (width is { } w && w > 0)
            fields["size_x"] = UnitConverter.FormatDouble(UnitConverter.Length(w));
        if (height is { } h && h > 0)
            fields["size_y"] = UnitConverter.FormatDouble(UnitConverter.Length(h));

        // shape is required. When Revit exposes no STRUCTURAL_SECTION_SHAPE and the
        // section isn't round, fall back to the generic rectangular profile.
        fields.TryAdd("shape", "rect");

        return fields;
    }

    static string MapShape(string shapeStr)
    {
        var lower = shapeStr.ToLowerInvariant();
        return lower switch
        {
            _ when lower.Contains("round") || lower.Contains("circle") || lower.Contains("pipe") => "round",
            _ when lower.Contains("i ") || lower.Contains("wide flange") || lower.Contains("w shape") || lower.Contains("i-shape") => "i_shape",
            _ when lower.Contains("channel") || lower.Contains("c shape") || lower.Contains("c-shape") => "c_shape",
            _ when lower.Contains("angle") || lower.Contains("l shape") || lower.Contains("l-shape") => "l_shape",
            _ when lower.Contains("tee") || lower.Contains("t shape") || lower.Contains("t-shape") => "t_shape",
            _ when lower.Contains("cross") => "cross",
            _ => "rect"
        };
    }
}
