namespace BimDown.RevitAddin.Mapping;

/// <summary>A curtain panel located on its wall: centre along the wall from the start, height above the base.</summary>
/// <param name="Kind">glass, solid, door, double_door or empty</param>
/// <param name="Mark">Door panel mark (door / double_door only)</param>
public record CurtainPanel(double Along, double Height, string Kind, string? Mark = null);

public static class CurtainGridMapper
{
    /// <summary>
    /// Curtain wall panel kind from the Revit panel: a door family (Doors
    /// category) is a door / double_door, "Empty" system panels are empty,
    /// opaque / solid panels and spandrels are solid, the rest glass.
    /// </summary>
    public static string PanelKind(bool isDoor, string familyName, string typeName, string? materialName)
    {
        var n = $"{familyName} {typeName}";
        if (isDoor)
            return Names.ContainsAny(n, "double", "pair", "双", "对开") ? "double_door" : "door";
        if (Names.ContainsAny(n, "empty", "空")) return "empty";
        if (Names.ContainsAny(n, "solid", "spandrel", "opaque", "实体", "层间", "不透明")) return "solid";
        if (!string.IsNullOrWhiteSpace(materialName) && MaterialMapper.MapToEnum(materialName) is not ("glass" or "composite"))
            return "solid";
        return "glass";
    }

    /// <summary>
    /// curtain_wall grid fields from the explicit Revit grid lines: v_grids =
    /// vertical lines as distances from the start, u_grids = horizontal lines as
    /// heights above the base (Revit U lines are the horizontal ones on walls),
    /// panels = non-glass cells as col:row=kind (a row of one kind as *:row=kind),
    /// door_numbers = door panel marks in cell order. Lines at the wall ends are
    /// dropped (validate requires them inside the wall).
    /// </summary>
    public static Dictionary<string, string?> Map(double length, double height,
        IEnumerable<double> vPositions, IEnumerable<double> uHeights, IReadOnlyList<CurtainPanel> panels)
    {
        const double eps = 0.005;
        var v = Clean(vPositions, length, eps);
        var u = Clean(uHeights, height, eps);
        var f = new Dictionary<string, string?>
        {
            ["v_grids"] = v.Count > 0 ? string.Join(";", v.Select(x => Names.Num(x, 3))) : null,
            ["u_grids"] = u.Count > 0 ? string.Join(";", u.Select(x => Names.Num(x, 3))) : null,
            // Without explicit lines the wall is one cell in that direction.
            ["v_grid_count"] = v.Count > 0 ? null : "1",
            ["u_grid_count"] = u.Count > 0 ? null : "1",
        };

        var cols = v.Count + 1;
        var rows = u.Count + 1;
        var cells = new Dictionary<(int Col, int Row), CurtainPanel>();
        foreach (var p in panels)
        {
            var col = v.Count(x => x < p.Along - eps);
            var row = u.Count(x => x < p.Height - eps);
            cells[(Math.Min(col, cols - 1), Math.Min(row, rows - 1))] = p;
        }

        var entries = new List<string>();
        var covered = new Dictionary<int, string>();
        for (var r = 0; r < rows; r++)
        {
            var kinds = Enumerable.Range(0, cols).Select(c => cells.TryGetValue((c, r), out var p) ? p.Kind : "glass").Distinct().ToList();
            if (cols > 1 && kinds.Count == 1 && kinds[0] != "glass" && kinds[0] is not ("door" or "double_door"))
            {
                entries.Add($"*:{r}={kinds[0]}");
                covered[r] = kinds[0];
            }
        }
        foreach (var ((c, r), p) in cells.OrderBy(k => k.Key.Col).ThenBy(k => k.Key.Row))
        {
            var applied = covered.GetValueOrDefault(r, "glass");
            if (p.Kind != applied) entries.Add($"{c}:{r}={p.Kind}");
        }
        f["panels"] = entries.Count > 0 ? string.Join(";", entries) : null;

        var doors = cells.Where(k => k.Value.Kind is "door" or "double_door")
            .OrderBy(k => k.Key.Col).ThenBy(k => k.Key.Row).Select(k => k.Value.Mark).ToList();
        f["door_numbers"] = doors.Count > 0 && doors.All(m => !string.IsNullOrWhiteSpace(m))
            ? string.Join(";", doors!)
            : null;
        return f;
    }

    static List<double> Clean(IEnumerable<double> values, double max, double eps) =>
        values.Where(x => x > eps && x < max - eps)
            .OrderBy(x => x)
            .Aggregate(new List<double>(), (acc, x) =>
            {
                if (acc.Count == 0 || x - acc[^1] > eps) acc.Add(x);
                return acc;
            });
}
