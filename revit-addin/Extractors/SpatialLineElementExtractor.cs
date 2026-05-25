using Autodesk.Revit.DB;

namespace BimDown.RevitAddin.Extractors;

public class SpatialLineElementExtractor : IFieldExtractor
{
    public IReadOnlyList<string> FieldNames { get; } = ["start_z", "end_z"];

    // start_z/end_z are folded into the 3D GeoJSON coordinates, like start_x/y (see
    // LineElementExtractor) — geometry, not CSV columns.
    public IReadOnlyList<string> ComputedFieldNames { get; } = ["start_z", "end_z"];

    public Dictionary<string, string?> Extract(Element element)
    {
        var fields = new Dictionary<string, string?>();

        if (element.Location is LocationCurve loc)
        {
            var curve = loc.Curve;
            var start = curve.GetEndPoint(0);
            var end = curve.GetEndPoint(1);
            fields["start_z"] = UnitConverter.FormatDouble(UnitConverter.Length(start.Z));
            fields["end_z"] = UnitConverter.FormatDouble(UnitConverter.Length(end.Z));
        }

        return fields;
    }
}
