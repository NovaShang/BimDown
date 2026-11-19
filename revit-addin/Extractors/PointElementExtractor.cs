using Autodesk.Revit.DB;

namespace BimDown.RevitAddin.Extractors;

public class PointElementExtractor : IFieldExtractor
{
    // _z: absolute height of the insertion point (places elements Revit gives no level).
    public IReadOnlyList<string> FieldNames { get; } = ["x", "y", "rotation", "_z"];
    public IReadOnlyList<string> ComputedFieldNames { get; } = ["x", "y", "rotation", "_z"];

    public Dictionary<string, string?> Extract(Element element)
    {
        var fields = new Dictionary<string, string?>();

        if (element.Location is LocationPoint lp)
        {
            fields["x"] = UnitConverter.FormatDouble(UnitConverter.Length(lp.Point.X));
            fields["y"] = UnitConverter.FormatDouble(UnitConverter.Length(lp.Point.Y));
            fields["rotation"] = UnitConverter.FormatDouble(UnitConverter.Angle(lp.Rotation));
            fields["_z"] = UnitConverter.FormatDouble(UnitConverter.Length(lp.Point.Z));
        }

        return fields;
    }
}
