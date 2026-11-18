namespace BimDown.RevitAddin.Mapping;

/// <summary>
/// The element-type resolution rule (spec readme, "Element Types"): a field a
/// type table shares by name with an instance table is a type parameter; an
/// instance leaves it empty to inherit or sets it to override.
/// </summary>
public static class TypeInheritance
{
    /// <summary>Instance table → its type table.</summary>
    public static readonly IReadOnlyDictionary<string, string> TypeTableOf = new Dictionary<string, string>
    {
        ["wall"] = "wall_type", ["structure_wall"] = "wall_type",
        ["slab"] = "slab_type", ["structure_slab"] = "slab_type",
        ["roof"] = "roof_type", ["ceiling"] = "ceiling_type",
        ["door"] = "door_type", ["window"] = "window_type", ["curtain_wall"] = "curtain_wall_type",
        ["column"] = "column_type", ["structure_column"] = "column_type",
        ["beam"] = "beam_type", ["brace"] = "beam_type",
        ["foundation"] = "foundation_type", ["furniture"] = "furniture_type", ["railing"] = "railing_type",
    };

    static readonly string[] Section = ["shape", "size_x", "size_y", "flange", "web", "thickness", "root_radius", "designation", "material", "material_grade"];

    /// <summary>Type parameters per instance table (fields shared by name with the type table).</summary>
    public static readonly IReadOnlyDictionary<string, string[]> TypeParams = new Dictionary<string, string[]>
    {
        ["wall"] = ["thickness", "material"],
        ["structure_wall"] = ["thickness", "material"],
        ["slab"] = ["thickness", "material"],
        ["structure_slab"] = ["thickness", "material", "material_grade"],
        ["roof"] = ["thickness", "material"],
        ["ceiling"] = ["material"],
        ["door"] = ["width", "height", "operation", "material"],
        ["window"] = ["width", "height", "operation", "material"],
        ["curtain_wall"] = ["u_spacing", "v_spacing", "panel_material", "solid_material", "mullion_width", "mullion_depth", "mullion_profile", "material"],
        ["column"] = ["shape", "size_x", "size_y", "material"],
        ["structure_column"] = Section,
        ["beam"] = Section,
        ["brace"] = Section,
        ["foundation"] = ["kind", "width", "length", "thickness", "material", "material_grade"],
        ["furniture"] = ["family", "variant", "size_x", "size_y", "height"],
        ["railing"] = ["height", "baluster_spacing", "material"],
    };

    static bool SameValue(string? a, string? b)
    {
        if (string.IsNullOrEmpty(a) || string.IsNullOrEmpty(b)) return false;
        if (Names.Parse(a) is { } x && Names.Parse(b) is { } y) return Math.Abs(x - y) < 5e-4;
        return string.Equals(a, b, StringComparison.Ordinal);
    }

    /// <summary>
    /// Blanks instance values equal to the type's (tools write inherited values
    /// back as empty so editing the type updates its instances).
    /// </summary>
    public static void StripInherited(string table, IEnumerable<Dictionary<string, string?>> rows,
        IReadOnlyDictionary<string, Dictionary<string, string?>> typesById)
    {
        if (!TypeParams.TryGetValue(table, out var fields)) return;
        foreach (var row in rows)
        {
            var typeId = row.GetValueOrDefault("type_id");
            if (typeId is null || !typesById.TryGetValue(typeId, out var type)) continue;
            foreach (var f in fields)
                if (SameValue(row.GetValueOrDefault(f), type.GetValueOrDefault(f)))
                    row[f] = null;
        }
    }

    /// <summary>Fills empty type parameters of an instance row from its type (import).</summary>
    public static void FillFromType(string table, Dictionary<string, string?> row, Dictionary<string, string?> type)
    {
        if (!TypeParams.TryGetValue(table, out var fields)) return;
        foreach (var f in fields)
            if (string.IsNullOrEmpty(row.GetValueOrDefault(f)) && !string.IsNullOrEmpty(type.GetValueOrDefault(f)))
                row[f] = type[f];
    }

    /// <summary>Ids of the types some instance row references.</summary>
    public static HashSet<string> UsedTypeIds(IEnumerable<Dictionary<string, string?>> instanceRows) =>
        instanceRows.Select(r => r.GetValueOrDefault("type_id")).Where(id => !string.IsNullOrEmpty(id)).Select(id => id!).ToHashSet();
}
