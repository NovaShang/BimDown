namespace BimDown.RevitAddin.Mapping;

/// <summary>Roof shape classification for a footprint or extrusion roof.</summary>
/// <param name="RoofType">roof.roof_type</param>
/// <param name="Slope">roof.slope in degrees (largest edge slope)</param>
/// <param name="EdgeSlopes">roof.edge_slopes ("30;0;30;0") or null when implied</param>
public record RoofShape(string RoofType, double Slope, string? EdgeSlopes);

/// <summary>Plan footprint + underside profile of an extrusion roof.</summary>
public record ExtrusionRoofShape(IReadOnlyList<(double X, double Y)> Footprint, string Profile, double BaseOffset);

public static class RoofMapper
{
    /// <summary>
    /// Footprint roof → roof_type / slope / edge_slopes. <paramref name="edgeSlopesDeg"/>
    /// has one entry per footprint edge, in ring order (edge i from vertex i to i+1);
    /// null or 0 = the edge does not define a slope (Revit "Defines Slope" off).
    /// A hip with one slope on every edge is fully implied; any other sloped
    /// roof writes edge_slopes so the exact Revit configuration survives.
    /// </summary>
    public static RoofShape Classify(IReadOnlyList<double?> edgeSlopesDeg)
    {
        var slopes = edgeSlopesDeg.Select(s => s is { } v ? Math.Abs(v) : 0).ToList();
        var sloped = slopes.Count(s => s > 1e-6);
        if (slopes.Count == 0 || sloped == 0) return new RoofShape("flat", 0, null);

        var max = slopes.Max();
        string type = sloped == slopes.Count ? "hip" : sloped == 1 ? "shed" : "gable";
        // A flat roof drawn with small drainage slopes stays flat with its edge slopes.
        if (max < 5) type = "flat";
        var uniformHip = type == "hip" && slopes.All(s => Math.Abs(s - max) < 0.01);
        var edges = uniformHip ? null : string.Join(";", slopes.Select(s => Names.Num(s, 2)));
        return new RoofShape(type, Math.Round(max, 2), edges);
    }

    /// <summary>
    /// Revit stores FootPrintRoof slopes as rise / run; BimDown uses degrees.
    /// </summary>
    public static double SlopeTangentToDegrees(double tangent) => Math.Atan(Math.Abs(tangent)) * 180.0 / Math.PI;

    /// <summary>
    /// Extrusion roof → footprint polygon + profile. The Revit profile is a curve in
    /// a vertical plane (points as (h, z): h along the plane's horizontal axis, z
    /// above the roof's level); the roof is extruded along the plane normal from
    /// <paramref name="extrusionStart"/> to <paramref name="extrusionEnd"/>. The
    /// BimDown footprint's first edge runs along the extrusion at the smallest h,
    /// so u = h − h_min; the profile is the underside (Revit sketches the top) and
    /// base_offset its lowest point.
    /// </summary>
    public static ExtrusionRoofShape Extrusion(
        IReadOnlyList<(double H, double Z)> profile, double thickness,
        (double X, double Y) planeOrigin, (double X, double Y) hAxis, (double X, double Y) normal,
        double extrusionStart, double extrusionEnd)
    {
        if (profile.Count < 2) throw new ArgumentException("profile needs two points", nameof(profile));
        var pts = profile
            .Select(p => (p.H, Z: p.Z - thickness))
            .OrderBy(p => p.H)
            .ToList();
        var dedup = new List<(double H, double Z)>();
        foreach (var p in pts)
            if (dedup.Count == 0 || Math.Abs(p.H - dedup[^1].H) > 1e-4) dedup.Add(p);

        var hMin = dedup[0].H;
        var hMax = dedup[^1].H;
        var zMin = dedup.Min(p => p.Z);
        var e0 = Math.Min(extrusionStart, extrusionEnd);
        var e1 = Math.Max(extrusionStart, extrusionEnd);

        (double X, double Y) At(double h, double e) =>
            (planeOrigin.X + hAxis.X * h + normal.X * e, planeOrigin.Y + hAxis.Y * h + normal.Y * e);

        // First edge along the extrusion at h_min; the ring then goes across to h_max.
        var footprint = new List<(double X, double Y)> { At(hMin, e0), At(hMin, e1), At(hMax, e1), At(hMax, e0) };
        var profileText = string.Join(";", dedup.Select(p => $"{Names.Num(p.H - hMin, 3)},{Names.Num(p.Z - zMin, 3)}"));
        return new ExtrusionRoofShape(footprint, profileText, zMin);
    }
}
