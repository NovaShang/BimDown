using Autodesk.Revit.DB;

namespace BimDown.RevitAddin.Extractors;

public class SectionProfileExtractor : IFieldExtractor
{
    public IReadOnlyList<string> FieldNames { get; } = ["shape", "size_x", "size_y"];

    public Dictionary<string, string?> Extract(Element element)
    {
        var fields = new Dictionary<string, string?>();

        // Try round (diameter). RBS_CURVE_DIAMETER_PARAM covers pipes; conduits use
        // their own RBS_CONDUIT_DIAMETER_PARAM (with outer/inner variants as fallback).
        var diameter = element.get_Parameter(BuiltInParameter.RBS_CURVE_DIAMETER_PARAM).AsPositiveDouble()
                    ?? element.get_Parameter(BuiltInParameter.RBS_CONDUIT_DIAMETER_PARAM).AsPositiveDouble()
                    ?? element.get_Parameter(BuiltInParameter.RBS_CONDUIT_OUTER_DIAM_PARAM).AsPositiveDouble()
                    ?? ParameterUtils.FindDoubleParameterByNames(element, "diameter", "d", "直径");
        if (diameter is { } d && d > 0)
        {
            fields["shape"] = "round";
            fields["size_x"] = UnitConverter.FormatDouble(UnitConverter.Length(d));
            fields["size_y"] = UnitConverter.FormatDouble(UnitConverter.Length(d));
            return fields;
        }

        // Try rectangular (width/height) — check both instance and type built-in params
        var width = element.get_Parameter(BuiltInParameter.RBS_CURVE_WIDTH_PARAM).AsPositiveDouble()
                 ?? element.get_Parameter(BuiltInParameter.FAMILY_WIDTH_PARAM).AsPositiveDouble()
                 ?? GetTypeParameter(element, BuiltInParameter.FAMILY_WIDTH_PARAM).AsPositiveDouble()
                 ?? ParameterUtils.FindDoubleParameterByNames(element, "width", "w", "b", "宽");
        var height = element.get_Parameter(BuiltInParameter.RBS_CURVE_HEIGHT_PARAM).AsPositiveDouble()
                  ?? element.get_Parameter(BuiltInParameter.FAMILY_HEIGHT_PARAM).AsPositiveDouble()
                  ?? GetTypeParameter(element, BuiltInParameter.FAMILY_HEIGHT_PARAM).AsPositiveDouble()
                  ?? ParameterUtils.FindDoubleParameterByNames(element, "height", "depth", "h", "d", "高", "深");
        if (width is { } w && w > 0 && height is { } h && h > 0)
        {
            fields["shape"] = "rect";
            fields["size_x"] = UnitConverter.FormatDouble(UnitConverter.Length(w));
            fields["size_y"] = UnitConverter.FormatDouble(UnitConverter.Length(h));
            return fields;
        }

        // Fallback: compute from bounding box for point-based elements (columns)
        if (element.Location is LocationPoint && element.get_BoundingBox(null) is { } bb)
        {
            var dx = bb.Max.X - bb.Min.X;
            var dy = bb.Max.Y - bb.Min.Y;
            if (dx > 0 && dy > 0)
            {
                // Determine shape: round if roughly square and name suggests round
                var name = (element.Name + " " + (element as FamilyInstance)?.Symbol?.Family?.Name).ToLowerInvariant();
                var isRound = name.Contains("round") || name.Contains("circular") || name.Contains("圆");
                if (!isRound && Math.Abs(dx - dy) < 0.001) // equal sides, could be round
                    isRound = name.Contains("pipe") || name.Contains("tube");

                fields["shape"] = isRound ? "round" : "rect";
                fields["size_x"] = UnitConverter.FormatDouble(UnitConverter.Length(dx));
                fields["size_y"] = UnitConverter.FormatDouble(UnitConverter.Length(dy));
                return fields;
            }
        }

        return fields;
    }

    static Parameter? GetTypeParameter(Element element, BuiltInParameter param)
    {
        var typeId = element.GetTypeId();
        if (typeId is null || typeId == ElementId.InvalidElementId) return null;
        return element.Document.GetElement(typeId)?.get_Parameter(param);
    }
}
