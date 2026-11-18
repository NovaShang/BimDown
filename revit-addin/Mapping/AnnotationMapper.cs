namespace BimDown.RevitAddin.Mapping;

/// <summary>One measured segment of a Revit linear dimension, in plan meters.</summary>
/// <param name="OriginX">Segment midpoint on the dimension line</param>
/// <param name="Value">Measured length</param>
public record DimensionSegmentInput(double OriginX, double OriginY, double Value, string? ValueOverride = null);

public static class AnnotationMapper
{
    /// <summary>Revit text type height (model text size on paper, meters) → text_note.paper_size in mm.</summary>
    public static double PaperSizeMm(double textSizeMeters) => Math.Round(textSizeMeters * 1000, 2);

    /// <summary>Text rotation in degrees CCW from a base direction vector.</summary>
    public static double RotationDeg(double dirX, double dirY)
    {
        var deg = Math.Atan2(dirY, dirX) * 180 / Math.PI;
        if (Math.Abs(deg) < 1e-6) return 0;
        return Math.Round(deg < 0 ? deg + 360 : deg, 3);
    }

    /// <summary>
    /// dimension rows for a Revit linear dimension: one row per segment (a chain
    /// shares direction and offset), measured points on the dimension line itself
    /// (offset 0) so the line is drawn where Revit draws it. Fixed points: the
    /// referenced faces are not BimDown anchors.
    /// </summary>
    public static List<Dictionary<string, string?>> DimensionRows(string idBase, double dirX, double dirY,
        IReadOnlyList<DimensionSegmentInput> segments)
    {
        var len = Math.Sqrt(dirX * dirX + dirY * dirY);
        var rows = new List<Dictionary<string, string?>>();
        if (len < 1e-9) return rows;
        var (ux, uy) = (dirX / len, dirY / len);
        var direction = RotationDeg(ux, uy);
        var i = 0;
        foreach (var s in segments)
        {
            if (s.Value < 1e-4) continue;
            var h = s.Value / 2;
            rows.Add(new Dictionary<string, string?>
            {
                ["id"] = segments.Count == 1 ? idBase : $"{idBase}:seg:{i}",
                ["start_x"] = Names.Num(s.OriginX - ux * h, 4),
                ["start_y"] = Names.Num(s.OriginY - uy * h, 4),
                ["end_x"] = Names.Num(s.OriginX + ux * h, 4),
                ["end_y"] = Names.Num(s.OriginY + uy * h, 4),
                ["direction"] = Names.Num(direction, 3),
                ["offset"] = "0",
                ["text"] = string.IsNullOrWhiteSpace(s.ValueOverride) ? null : s.ValueOverride,
            });
            i++;
        }
        return rows;
    }
}
