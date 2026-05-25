using Autodesk.Revit.DB;

namespace BimDown.RevitAddin.Extractors;

/// <summary>
/// Extracts MEP curve geometry from connector positions rather than LocationCurve endpoints.
/// Connector positions align with the fitting connectors on each end, ensuring that
/// mep_curve endpoints and mep_node positions naturally coincide.
/// Falls back to LocationCurve if connectors are unavailable.
/// </summary>
public class MepCurveGeometryExtractor : IFieldExtractor
{
    public IReadOnlyList<string> FieldNames { get; } = ["start_x", "start_y", "end_x", "end_y", "length", "start_z", "end_z", "_svg_d"];
    // start_z/end_z are folded into the 3D GeoJSON coordinates — geometry, not CSV columns.
    public IReadOnlyList<string> ComputedFieldNames { get; } = ["start_x", "start_y", "end_x", "end_y", "length", "start_z", "end_z", "_svg_d"];

    public Dictionary<string, string?> Extract(Element element)
    {
        var fields = new Dictionary<string, string?>();

        XYZ? startPt = null;
        XYZ? endPt = null;

        // Try to get endpoints from connectors (preferred for MEP curves)
        if (element is MEPCurve mepCurve)
        {
            var connectors = mepCurve.ConnectorManager?.Connectors;
            if (connectors is not null)
            {
                foreach (Connector conn in connectors)
                {
                    if (conn.ConnectorType != ConnectorType.End) continue;

                    if (startPt is null)
                        startPt = conn.Origin;
                    else if (endPt is null)
                        endPt = conn.Origin;
                }
            }
        }

        // Fallback to LocationCurve (handles both Line and Arc)
        if ((startPt is null || endPt is null) && element.Location is LocationCurve loc)
        {
            var curve = loc.Curve;
            startPt ??= curve.GetEndPoint(0);
            endPt ??= curve.GetEndPoint(1);
        }

        if (startPt is null || endPt is null) return fields;

        var sx = UnitConverter.Length(startPt.X);
        var sy = UnitConverter.Length(startPt.Y);
        var ex = UnitConverter.Length(endPt.X);
        var ey = UnitConverter.Length(endPt.Y);

        fields["start_x"] = UnitConverter.FormatDouble(sx);
        fields["start_y"] = UnitConverter.FormatDouble(sy);
        fields["end_x"] = UnitConverter.FormatDouble(ex);
        fields["end_y"] = UnitConverter.FormatDouble(ey);
        fields["start_z"] = UnitConverter.FormatDouble(UnitConverter.Length(startPt.Z));
        fields["end_z"] = UnitConverter.FormatDouble(UnitConverter.Length(endPt.Z));

        // Generate _svg_d — check if the underlying curve is an arc
        if (element.Location is LocationCurve { Curve: Arc arc })
        {
            var r = UnitConverter.Length(arc.Radius);
            var (largeArc, sweep) = LineElementExtractor.ComputeArcFlags(arc);
            fields["_svg_d"] = $"M {Fmt(sx)},{Fmt(sy)} A {Fmt(r)},{Fmt(r)} 0 {largeArc},{sweep} {Fmt(ex)},{Fmt(ey)}";

            fields["length"] = UnitConverter.FormatDouble(UnitConverter.Length(arc.Length));
        }
        else
        {
            fields["_svg_d"] = $"M {Fmt(sx)},{Fmt(sy)} L {Fmt(ex)},{Fmt(ey)}";

            var dx = endPt.X - startPt.X;
            var dy = endPt.Y - startPt.Y;
            var dz = endPt.Z - startPt.Z;
            fields["length"] = UnitConverter.FormatDouble(UnitConverter.Length(
                Math.Sqrt(dx * dx + dy * dy + dz * dz)));
        }

        return fields;
    }

    static string Fmt(double v) => UnitConverter.FormatDouble(v);
}
