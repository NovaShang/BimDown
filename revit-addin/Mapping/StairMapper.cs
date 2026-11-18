namespace BimDown.RevitAddin.Mapping;

/// <summary>One stair run in meters: walking line from the bottom riser to the top.</summary>
/// <param name="Style">StairsRunStyle name (Straight, Winder, Spiral, Sketched)</param>
public record StairRunInput(string Id, double X0, double Y0, double Z0, double X1, double Y1, double Z1,
    double Width, int Risers, string Style = "Straight");

/// <summary>
/// Revit stair by component → stair / stair_run rows: the lowest run is the
/// stair's own line, the others become stair_run rows, and the run directions
/// decide stair_type.
/// </summary>
public static class StairMapper
{
    public static IReadOnlyList<StairRunInput> Order(IEnumerable<StairRunInput> runs) =>
        runs.OrderBy(r => r.Z0).ThenBy(r => r.Z1).ToList();

    /// <summary>Overall shape (IfcStairTypeEnum subset) from the ordered runs.</summary>
    public static string Classify(IReadOnlyList<StairRunInput> ordered)
    {
        if (ordered.Count == 0) return "straight";
        if (ordered.Any(r => r.Style == "Spiral")) return "spiral";
        if (ordered.Any(r => r.Style == "Winder")) return "winder";

        var turn = 0.0;
        for (var i = 1; i < ordered.Count; i++)
        {
            var a = Math.Atan2(ordered[i - 1].Y1 - ordered[i - 1].Y0, ordered[i - 1].X1 - ordered[i - 1].X0);
            var b = Math.Atan2(ordered[i].Y1 - ordered[i].Y0, ordered[i].X1 - ordered[i].X0);
            var d = b - a;
            while (d > Math.PI) d -= 2 * Math.PI;
            while (d < -Math.PI) d += 2 * Math.PI;
            turn += d;
        }
        var deg = Math.Abs(turn) * 180 / Math.PI;
        if (ordered.Count == 1 || deg < 20) return ordered.Any(r => r.Style == "Sketched") ? "curved" : "straight";
        if (deg < 135) return "quarter_turn";
        if (deg < 225) return "half_turn";
        return "spiral";
    }

    /// <summary>
    /// Fields of a stair_run row hosted on <paramref name="stairUid"/> (its 3D line
    /// goes into the row's start_* / end_* geometry fields).
    /// </summary>
    public static Dictionary<string, string?> RunRow(StairRunInput r, string stairUid) => new()
    {
        ["id"] = r.Id,
        ["host_id"] = stairUid,
        ["width"] = r.Width > 0 ? Names.Num(r.Width, 3) : null,
        ["step_count"] = r.Risers > 0 ? r.Risers.ToString(System.Globalization.CultureInfo.InvariantCulture) : null,
        ["start_x"] = Names.Num(r.X0), ["start_y"] = Names.Num(r.Y0), ["start_z"] = Names.Num(r.Z0),
        ["end_x"] = Names.Num(r.X1), ["end_y"] = Names.Num(r.Y1), ["end_z"] = Names.Num(r.Z1),
    };

    /// <summary>
    /// Side (looking up the stair) of a railing hosted on it: the sign of the
    /// cross product of the first run's direction and the vector to the railing's
    /// path midpoint.
    /// </summary>
    public static string RailingSide(StairRunInput firstRun, double px, double py)
    {
        var dx = firstRun.X1 - firstRun.X0;
        var dy = firstRun.Y1 - firstRun.Y0;
        var mx = (firstRun.X0 + firstRun.X1) / 2;
        var my = (firstRun.Y0 + firstRun.Y1) / 2;
        var cross = dx * (py - my) - dy * (px - mx);
        return cross >= 0 ? "left" : "right";
    }
}
