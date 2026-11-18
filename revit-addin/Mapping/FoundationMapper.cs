namespace BimDown.RevitAddin.Mapping;

public static class FoundationMapper
{
    /// <summary>
    /// foundation.kind from the Revit element class and family naming:
    /// floor-based foundation slabs are rafts, wall foundations strips, and
    /// isolated families pads unless named as a pile or pile cap.
    /// </summary>
    /// <param name="revitClass">"Floor", "WallFoundation" or "FamilyInstance"</param>
    public static string Kind(string revitClass, string familyName, string typeName)
    {
        if (revitClass == "Floor") return "raft";
        if (revitClass == "WallFoundation") return "strip";
        var n = $"{familyName} {typeName}";
        if (Names.ContainsAny(n, "pile cap", "pilecap", "pile-cap", "承台")) return "pile_cap";
        if (Names.ContainsAny(n, "pile", "桩")) return "pile";
        if (Names.ContainsAny(n, "strip", "continuous", "条形")) return "strip";
        if (Names.ContainsAny(n, "raft", "mat foundation", "筏")) return "raft";
        return "pad";
    }

    /// <summary>
    /// Rectangle of <paramref name="width"/> (local X) × <paramref name="length"/>
    /// (local Y) centred on (cx, cy), turned by <paramref name="rotationDeg"/> CCW:
    /// the footprint of a pile cap family (Polygon form of a foundation).
    /// </summary>
    public static List<(double X, double Y)> RectFootprint(double cx, double cy, double width, double length, double rotationDeg)
    {
        var a = rotationDeg * Math.PI / 180;
        var (c, s) = (Math.Cos(a), Math.Sin(a));
        var hw = width / 2;
        var hl = length / 2;
        return new[] { (-hw, -hl), (hw, -hl), (hw, hl), (-hw, hl) }
            .Select(p => (cx + p.Item1 * c - p.Item2 * s, cy + p.Item1 * s + p.Item2 * c))
            .ToList();
    }
}
