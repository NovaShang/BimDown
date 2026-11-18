using Autodesk.Revit.DB;

namespace BimDown.RevitAddin.Tables;

/// <summary>Plan outline of a roof from its solid (fallback when no sketch is readable).</summary>
static class RoofGeometry
{
    /// <summary>
    /// Derives a roof's plan-view outline from its solid geometry by:
    ///   1. collecting every upward-facing PlanarFace,
    ///   2. counting each edge (keyed by XY-projected endpoints),
    ///   3. keeping edges that appear exactly once (boundary; shared edges
    ///      between two top faces are ridges/hips and are internal),
    ///   4. chaining boundary edges into closed loops and returning the
    ///      largest loop by bounding-box area.
    ///
    /// Works for any roof type (FootPrintRoof, ExtrusionRoof, base RoofBase
    /// with tapered insulation, curved sketches, etc.). Used as a fallback
    /// when GetRoofFootprint can't read a sketch.
    /// </summary>
    internal static (IList<XYZ> Points, bool HasCurvedEdges)? OutlineFromSolid(Element element)
    {
        var opt = new Options { ComputeReferences = false, DetailLevel = ViewDetailLevel.Coarse };
        var geom = element.get_Geometry(opt);
        if (geom is null) return null;

        // 1. Collect top-facing planar faces from all solids.
        var topFaces = new List<PlanarFace>();
        foreach (var obj in geom)
        {
            var solid = obj as Solid ?? (obj as GeometryInstance)?.GetInstanceGeometry()
                .OfType<Solid>().FirstOrDefault(s => s.Faces.Size > 0);
            if (solid is null) continue;
            foreach (Face face in solid.Faces)
                if (face is PlanarFace planar && planar.FaceNormal.Z > 0.1)
                    topFaces.Add(planar);
        }
        if (topFaces.Count == 0) return null;

        // 2+3. Count edges; boundary = appears exactly once across all top faces.
        var edgeMap = new Dictionary<string, (XYZ Start, XYZ End, bool IsCurved, int Count)>();
        foreach (var face in topFaces)
        {
            foreach (var loop in face.GetEdgesAsCurveLoops())
            {
                foreach (var curve in loop)
                {
                    var a = curve.GetEndPoint(0);
                    var b = curve.GetEndPoint(1);
                    var key = MakeEdgeKey(a, b);
                    if (edgeMap.TryGetValue(key, out var existing))
                        edgeMap[key] = (existing.Start, existing.End, existing.IsCurved, existing.Count + 1);
                    else
                        edgeMap[key] = (a, b, curve is not Line, 1);
                }
            }
        }

        // Project boundary edges to XY.
        var boundary = edgeMap.Values
            .Where(v => v.Count == 1)
            .Select(v => (Start: new XYZ(v.Start.X, v.Start.Y, 0),
                          End: new XYZ(v.End.X, v.End.Y, 0),
                          v.IsCurved))
            .ToList();
        if (boundary.Count < 3) return null;

        // 4. Chain into closed loops. A complex roof may yield multiple
        // disconnected loops (outer boundary + holes / tiny artifacts).
        const double tol = 1e-3;
        var used = new bool[boundary.Count];
        var loops = new List<(List<XYZ> Points, bool HasCurved)>();

        while (true)
        {
            var startIdx = -1;
            for (var i = 0; i < boundary.Count; i++) if (!used[i]) { startIdx = i; break; }
            if (startIdx < 0) break;

            var points = new List<XYZ> { boundary[startIdx].Start };
            var current = boundary[startIdx].End;
            var hasCurved = boundary[startIdx].IsCurved;
            used[startIdx] = true;

            while (true)
            {
                points.Add(current);
                var found = -1;
                var reversed = false;
                for (var i = 0; i < boundary.Count; i++)
                {
                    if (used[i]) continue;
                    if (boundary[i].Start.DistanceTo(current) < tol) { found = i; reversed = false; break; }
                    if (boundary[i].End.DistanceTo(current) < tol) { found = i; reversed = true; break; }
                }
                if (found < 0) break;
                used[found] = true;
                if (boundary[found].IsCurved) hasCurved = true;
                current = reversed ? boundary[found].Start : boundary[found].End;
                if (current.DistanceTo(points[0]) < tol) break;
            }
            if (points.Count >= 3) loops.Add((points, hasCurved));
        }

        if (loops.Count == 0) return null;

        // Return the loop with the largest XY bounding-box area (outer boundary).
        var best = loops.OrderByDescending(l =>
        {
            double minX = double.MaxValue, minY = double.MaxValue;
            double maxX = double.MinValue, maxY = double.MinValue;
            foreach (var p in l.Points)
            {
                if (p.X < minX) minX = p.X;
                if (p.X > maxX) maxX = p.X;
                if (p.Y < minY) minY = p.Y;
                if (p.Y > maxY) maxY = p.Y;
            }
            return (maxX - minX) * (maxY - minY);
        }).First();

        return (best.Points, best.HasCurved);
    }

    /// <summary>
    /// Creates a direction-independent key for an edge based on its XY-projected
    /// endpoints. Rounds to 0.001 ft (~0.3mm) to absorb floating-point drift
    /// between coincident vertices on adjacent faces.
    /// </summary>
    static string MakeEdgeKey(XYZ a, XYZ b)
    {
        var ci = System.Globalization.CultureInfo.InvariantCulture;
        var s1 = Math.Round(a.X, 3).ToString("F3", ci) + "," + Math.Round(a.Y, 3).ToString("F3", ci);
        var s2 = Math.Round(b.X, 3).ToString("F3", ci) + "," + Math.Round(b.Y, 3).ToString("F3", ci);
        return string.Compare(s1, s2, StringComparison.Ordinal) < 0 ? s1 + "|" + s2 : s2 + "|" + s1;
    }
}
