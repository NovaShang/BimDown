using System.Text;
using System.Text.Json;
using Autodesk.Revit.DB;

namespace BimDown.RevitAddin;

static class GeometryUtils
{
    public static (XYZ min, XYZ max)? GetBoundingBox(Element element)
    {
        // For FamilyInstance prefer the symbol's bbox (family-local frame, shared
        // by every instance of the type) — gives e.g. an AHU's nominal W×D×H
        // regardless of placement rotation. Fall back to the world AABB.
        BoundingBoxXYZ? bb = null;
        if (element is FamilyInstance fi)
            bb = fi.Symbol?.get_BoundingBox(null);
        bb ??= element.get_BoundingBox(null);
        return bb is null ? null : (bb.Min, bb.Max);
    }

    public static void WriteBoundingBox(Dictionary<string, string?> fields, Element element)
    {
        var bb = GetBoundingBox(element);
        if (bb is { } box)
        {
            fields["bbox_min_x"] = UnitConverter.FormatDouble(UnitConverter.Length(box.min.X));
            fields["bbox_min_y"] = UnitConverter.FormatDouble(UnitConverter.Length(box.min.Y));
            fields["bbox_min_z"] = UnitConverter.FormatDouble(UnitConverter.Length(box.min.Z));
            fields["bbox_max_x"] = UnitConverter.FormatDouble(UnitConverter.Length(box.max.X));
            fields["bbox_max_y"] = UnitConverter.FormatDouble(UnitConverter.Length(box.max.Y));
            fields["bbox_max_z"] = UnitConverter.FormatDouble(UnitConverter.Length(box.max.Z));
        }
    }

    /// <summary>
    /// Serializes polygon points to JSON format: [[x1,y1],[x2,y2],...]
    /// Points are converted from feet to meters.
    /// </summary>
    public static string SerializePolygon(IList<XYZ> points)
    {
        var sb = new StringBuilder("[");
        for (var i = 0; i < points.Count; i++)
        {
            if (i > 0) sb.Append(',');
            var p = points[i];
            sb.Append('[')
              .Append(UnitConverter.FormatDouble(UnitConverter.Length(p.X)))
              .Append(',')
              .Append(UnitConverter.FormatDouble(UnitConverter.Length(p.Y)))
              .Append(']');
        }
        sb.Append(']');
        return sb.ToString();
    }

    /// <summary>
    /// Extracts the largest downward-facing PlanarFace from an element's geometry.
    /// Returns the outer edge loop points.
    /// </summary>
    public static (IList<XYZ> Points, bool HasCurvedEdges)? GetTopFacePolygon(Element element)
    {
        var opt = new Options { ComputeReferences = false, DetailLevel = ViewDetailLevel.Coarse };
        var geom = element.get_Geometry(opt);
        if (geom is null) return null;

        PlanarFace? bestFace = null;
        double bestArea = 0;

        foreach (var obj in geom)
        {
            if (obj is Solid solid)
            {
                foreach (Face face in solid.Faces)
                {
                    if (face is PlanarFace planar && planar.FaceNormal.Z > 0.5)
                    {
                        if (planar.Area > bestArea)
                        {
                            bestArea = planar.Area;
                            bestFace = planar;
                        }
                    }
                }
            }
            else if (obj is GeometryInstance inst)
            {
                foreach (var subObj in inst.GetInstanceGeometry())
                {
                    if (subObj is Solid subSolid)
                    {
                        foreach (Face face in subSolid.Faces)
                        {
                            if (face is PlanarFace planar && planar.FaceNormal.Z > 0.5)
                            {
                                if (planar.Area > bestArea)
                                {
                                    bestArea = planar.Area;
                                    bestFace = planar;
                                }
                            }
                        }
                    }
                }
            }
        }

        if (bestFace is null) return null;

        var loops = bestFace.GetEdgesAsCurveLoops();
        if (loops.Count == 0) return null;

        // Use the outermost loop (largest perimeter)
        var outerLoop = loops.OrderByDescending(l => l.GetExactLength()).First();
        var points = new List<XYZ>();
        var hasCurvedEdges = false;
        foreach (var curve in outerLoop)
        {
            points.Add(curve.GetEndPoint(0));
            if (curve is not Line) hasCurvedEdges = true;
        }
        return (points, hasCurvedEdges);
    }

    /// <summary>
    /// Creates a Revit Curve from a row's geometry data. If _svg_d contains an arc, creates an Arc;
    /// otherwise creates a Line from start/end coordinates. Coordinates in meters, output in feet.
    /// </summary>
    public static Curve? CreateCurveFromRow(Dictionary<string, string?> row, double z = 0)
    {
        var startX = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(row.GetValueOrDefault("start_x")));
        var startY = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(row.GetValueOrDefault("start_y")));
        var endX = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(row.GetValueOrDefault("end_x")));
        var endY = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(row.GetValueOrDefault("end_y")));

        var start = new XYZ(startX, startY, z);
        var end = new XYZ(endX, endY, z);

        var svgD = row.GetValueOrDefault("_svg_d");
        if (svgD is not null && svgD.Contains('A'))
        {
            var arc = SvgArcToRevitArc(svgD, z);
            if (arc is not null) return arc;
        }

        if (start.DistanceTo(end) < 1e-9) return null;
        return Line.CreateBound(start, end);
    }

    /// <summary>
    /// Converts an SVG arc path "M x1,y1 A rx,ry 0 largeArc,sweep x2,y2" to a Revit Arc.
    /// Input coordinates are in meters, output Arc is in feet.
    /// </summary>
    public static Arc? SvgArcToRevitArc(string svgD, double z)
    {
        var parsed = Svg.SvgWriter.ParseArcCoordinates(svgD);
        if (parsed is null) return null;

        var (x1, y1, rx, _, largeArc, sweep, x2, y2) = parsed.Value;

        // Convert meters to feet
        var sx = UnitConverter.LengthToFeet(x1);
        var sy = UnitConverter.LengthToFeet(y1);
        var ex = UnitConverter.LengthToFeet(x2);
        var ey = UnitConverter.LengthToFeet(y2);
        var r = UnitConverter.LengthToFeet(rx);

        var start = new XYZ(sx, sy, z);
        var end = new XYZ(ex, ey, z);

        // Compute arc center from SVG parameters
        // Midpoint of chord
        var mx = (sx + ex) / 2;
        var my = (sy + ey) / 2;

        var dx = ex - sx;
        var dy = ey - sy;
        var chordLen = Math.Sqrt(dx * dx + dy * dy);
        var halfChord = chordLen / 2;

        if (r < halfChord) r = halfChord; // clamp

        var h = Math.Sqrt(r * r - halfChord * halfChord);

        // Perpendicular direction (unit vector)
        var px = -dy / chordLen;
        var py = dx / chordLen;

        // Choose side based on flags
        // In standard SVG math (Y down): sweep=1 means clockwise
        // We're in Revit (Y up), so we need to account for the flip
        var sign = (largeArc == sweep) ? 1.0 : -1.0;
        var cx = mx + px * h * sign;
        var cy = my + py * h * sign;

        // Compute a point on the arc (midpoint of arc) for Arc.Create
        var startAngle = Math.Atan2(sy - cy, sx - cx);
        var endAngle = Math.Atan2(ey - cy, ex - cx);

        // Determine mid-angle based on sweep direction
        double midAngle;
        if (sweep == 1)
        {
            // SVG sweep=1 = clockwise in SVG = counterclockwise in Revit (Y up)
            // Go CCW from start to end
            if (endAngle <= startAngle) endAngle += 2 * Math.PI;
            midAngle = (startAngle + endAngle) / 2;
            if (largeArc == 1 && Math.Abs(endAngle - startAngle) < Math.PI)
                midAngle += Math.PI;
        }
        else
        {
            // Go CW from start to end
            if (startAngle <= endAngle) startAngle += 2 * Math.PI;
            midAngle = (startAngle + endAngle) / 2;
            if (largeArc == 1 && Math.Abs(startAngle - endAngle) < Math.PI)
                midAngle += Math.PI;
        }

        var midPt = new XYZ(cx + r * Math.Cos(midAngle), cy + r * Math.Sin(midAngle), z);

        try
        {
            return Arc.Create(start, end, midPt);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Deserializes polygon JSON [[x1,y1],[x2,y2],...] to XYZ points.
    /// Input coordinates are in meters, output is in feet.
    /// </summary>
    public static IList<XYZ> DeserializePolygon(string json)
    {
        var points = new List<XYZ>();
        using var doc = JsonDocument.Parse(json);
        foreach (var pair in doc.RootElement.EnumerateArray())
        {
            var coords = pair.EnumerateArray().ToArray();
            var x = UnitConverter.LengthToFeet(coords[0].GetDouble());
            var y = UnitConverter.LengthToFeet(coords[1].GetDouble());
            points.Add(new XYZ(x, y, 0));
        }
        return points;
    }
}
