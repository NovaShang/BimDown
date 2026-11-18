using System.Globalization;
using System.Text.RegularExpressions;

namespace BimDown.RevitAddin.Mapping;

/// <summary>A wall-like boundary line in plan (meters).</summary>
/// <param name="CoreHi">Core face offset on the wall's left normal (exterior side), meters from the centre line.</param>
/// <param name="CoreLo">Core face offset on the right side (negative), meters.</param>
public record WallLine(string Id, double X0, double Y0, double X1, double Y1, double Thickness,
    double? CoreHi = null, double? CoreLo = null);

/// <summary>boundary_walls / boundary_face / boundary_offset of a wall-bounded element.</summary>
public record WallBoundary(IReadOnlyList<string> WallIds, string Face, double Offset);

/// <summary>
/// Wall direction convention and "Pick Walls" boundary detection.
/// BimDown puts a wall's exterior face (type_layer seq 1) on its left looking
/// from start to end; Revit stores the exterior side as Wall.Orientation, so a
/// wall whose orientation points right of its location line is exported reversed.
/// </summary>
public static partial class WallMapper
{
    /// <summary>True when the exterior (orientation) lies right of start → end.</summary>
    public static bool ShouldReverse(double dirX, double dirY, double orientX, double orientY) =>
        -dirY * orientX + dirX * orientY < -1e-9;

    /// <summary>
    /// A hosted door / window / opening on a reversed wall: distance from the
    /// other end, hinge on the other end, swing to the other side.
    /// </summary>
    public static void ReverseHosted(Dictionary<string, string?> row, double hostLength)
    {
        if (Names.Parse(row.GetValueOrDefault("position")) is { } p)
            row["position"] = Names.Num(Math.Max(0, hostLength - p));
        if (row.GetValueOrDefault("hinge_position") is { } h)
            row["hinge_position"] = h == "start" ? "end" : h == "end" ? "start" : h;
        if (row.GetValueOrDefault("swing_side") is { } s)
            row["swing_side"] = s == "left" ? "right" : s == "right" ? "left" : s;
    }

    [GeneratedRegex(@"^M\s*(?<sx>-?[\d.Ee+-]+),(?<sy>-?[\d.Ee+-]+)\s+(?:L\s*(?<ex>-?[\d.Ee+-]+),(?<ey>-?[\d.Ee+-]+)|A\s*(?<r1>[\d.Ee+-]+),(?<r2>[\d.Ee+-]+)\s+0\s+(?<la>[01]),(?<sw>[01])\s+(?<ax>-?[\d.Ee+-]+),(?<ay>-?[\d.Ee+-]+))\s*$")]
    private static partial Regex PathRegex();

    /// <summary>
    /// Swaps start / end of a line-element row (start_x … end_y and the internal
    /// _svg_d path, whose arc sweep flag flips with the direction).
    /// </summary>
    public static void ReverseLine(Dictionary<string, string?> row)
    {
        (row["start_x"], row["end_x"]) = (row.GetValueOrDefault("end_x"), row.GetValueOrDefault("start_x"));
        (row["start_y"], row["end_y"]) = (row.GetValueOrDefault("end_y"), row.GetValueOrDefault("start_y"));
        if (row.ContainsKey("start_z") || row.ContainsKey("end_z"))
            (row["start_z"], row["end_z"]) = (row.GetValueOrDefault("end_z"), row.GetValueOrDefault("start_z"));
        var d = row.GetValueOrDefault("_svg_d");
        if (d is null) return;
        var m = PathRegex().Match(d);
        if (!m.Success) return;
        var sx = m.Groups["sx"].Value;
        var sy = m.Groups["sy"].Value;
        if (m.Groups["ex"].Success)
            row["_svg_d"] = $"M {m.Groups["ex"].Value},{m.Groups["ey"].Value} L {sx},{sy}";
        else
        {
            var sweep = m.Groups["sw"].Value == "1" ? "0" : "1";
            row["_svg_d"] = $"M {m.Groups["ax"].Value},{m.Groups["ay"].Value} A {m.Groups["r1"].Value},{m.Groups["r2"].Value} 0 {m.Groups["la"].Value},{sweep} {sx},{sy}";
        }
    }

    static readonly string[] Faces = ["core", "interior", "centerline", "core_exterior", "exterior"];

    /// <summary>
    /// Inward distance (towards the polygon inside) from a wall's centre line to
    /// <paramref name="face"/> — the editor's faceDistance (pickBoundary.ts).
    /// </summary>
    public static double FaceDistance(string face, WallLine w, bool roomOnLeft)
    {
        var half = w.Thickness / 2;
        if (half <= 0) return 0;
        var hi = w.CoreHi ?? half;
        var lo = w.CoreLo ?? -half;
        return face switch
        {
            "centerline" => 0,
            "exterior" => -half,
            "interior" => half,
            "core" => roomOnLeft ? hi : -lo,
            "core_exterior" => roomOnLeft ? lo : -hi,
            _ => 0,
        };
    }

    /// <summary>
    /// Recognises a slab / roof / ceiling outline drawn along walls (Revit "Pick
    /// Walls"): every polygon edge lies parallel to a wall at one face, moved out by
    /// a common offset. Returns the walls in loop order, the face (preferring
    /// <paramref name="preferredFace"/> when several fit) and the outward offset,
    /// or null for a sketched outline.
    /// </summary>
    public static WallBoundary? MatchBoundary(IReadOnlyList<(double X, double Y)> polygon, IReadOnlyList<WallLine> walls,
        string preferredFace, double maxOffset = 2.0, double tol = 0.005)
    {
        if (polygon.Count < 3 || walls.Count < 2) return null;
        var ring = polygon.ToList();
        if (ring.Count > 3 && Math.Abs(ring[0].X - ring[^1].X) < 1e-9 && Math.Abs(ring[0].Y - ring[^1].Y) < 1e-9)
            ring.RemoveAt(ring.Count - 1);
        var reversed = SignedArea(ring) < 0;
        if (reversed) ring.Reverse();

        // Per edge: the walls it runs along with their inward centre-line distance.
        var edgeWalls = new List<List<(WallLine Wall, double Dist, bool RoomOnLeft)>>();
        for (var i = 0; i < ring.Count; i++)
        {
            var a = ring[i];
            var b = ring[(i + 1) % ring.Count];
            var ex = b.X - a.X;
            var ey = b.Y - a.Y;
            var el = Math.Sqrt(ex * ex + ey * ey);
            if (el < 1e-6) return null;
            var (ux, uy) = (ex / el, ey / el);
            var (nx, ny) = (-uy, ux); // inside on the left of a CCW ring

            var hits = new List<(WallLine, double, bool)>();
            foreach (var w in walls)
            {
                var wx = w.X1 - w.X0;
                var wy = w.Y1 - w.Y0;
                var wl = Math.Sqrt(wx * wx + wy * wy);
                if (wl < 1e-6) continue;
                var cross = (ux * wy - uy * wx) / wl;
                if (Math.Abs(cross) > 0.0175) continue; // parallel within ~1°
                // Signed inward distance of the edge from the wall's centre line.
                var dist = (a.X - w.X0) * nx + (a.Y - w.Y0) * ny;
                if (Math.Abs(dist) > w.Thickness / 2 + maxOffset) continue;
                // Overlap along the edge.
                var t0 = (w.X0 - a.X) * ux + (w.Y0 - a.Y) * uy;
                var t1 = (w.X1 - a.X) * ux + (w.Y1 - a.Y) * uy;
                var overlap = Math.Min(Math.Max(t0, t1), el) - Math.Max(Math.Min(t0, t1), 0);
                if (overlap < Math.Min(0.1, el * 0.5)) continue;
                var roomOnLeft = ux * wx + uy * wy > 0;
                hits.Add((w, dist, roomOnLeft));
            }
            if (hits.Count == 0) return null;
            // Keep the nearest wall(s): a slab edge runs along one wall, or several collinear ones.
            var best = hits.Min(h => Math.Abs(h.Item2));
            edgeWalls.Add(hits.Where(h => Math.Abs(Math.Abs(h.Item2) - best) < tol).ToList());
        }

        var ids = new List<string>();
        foreach (var e in edgeWalls)
            foreach (var h in e)
                if (!ids.Contains(h.Wall.Id)) ids.Add(h.Wall.Id);
        if (ids.Count < 2) return null;
        // List the walls in the stored polygon's own order.
        if (reversed) ids.Reverse();

        // Faces whose (expected − actual) distance is one common offset on every edge.
        var fits = new List<(string Face, double Offset)>();
        foreach (var face in Faces)
        {
            double? extra = null;
            var ok = true;
            foreach (var e in edgeWalls)
            {
                var h = e[0];
                var x = FaceDistance(face, h.Wall, h.RoomOnLeft) - h.Dist;
                if (extra is null) extra = x;
                else if (Math.Abs(extra.Value - x) > tol) { ok = false; break; }
            }
            if (ok && extra is { } off && off > -tol) fits.Add((face, Math.Max(0, off)));
        }
        if (fits.Count == 0) return null;
        var pick = fits.FirstOrDefault(f => f.Face == preferredFace && Math.Abs(f.Offset) < tol);
        if (pick.Face is null) pick = fits.OrderBy(f => Math.Abs(f.Offset)).ThenBy(f => f.Face == preferredFace ? 0 : 1).First();
        return new WallBoundary(ids, pick.Face, Math.Round(pick.Offset, 3));
    }

    public static double SignedArea(IReadOnlyList<(double X, double Y)> p)
    {
        var a = 0.0;
        for (var i = 0; i < p.Count; i++)
        {
            var q = p[(i + 1) % p.Count];
            a += p[i].X * q.Y - q.X * p[i].Y;
        }
        return a / 2;
    }

    /// <summary>Writes a <see cref="WallBoundary"/> into a row (ids still Revit UniqueIds; remapped later).</summary>
    public static void Apply(Dictionary<string, string?> row, WallBoundary b, string defaultFace)
    {
        row["boundary_walls"] = string.Join(";", b.WallIds);
        row["boundary_face"] = b.Face == defaultFace ? null : b.Face;
        row["boundary_offset"] = b.Offset > 0 ? b.Offset.ToString("0.###", CultureInfo.InvariantCulture) : null;
    }
}
