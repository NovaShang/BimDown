using Autodesk.Revit.DB;
using BimDown.RevitAddin.Mapping;

namespace BimDown.RevitAddin.Import;

/// <summary>
/// Data shared by the importers of one import run: the type tables (global/,
/// ids unique project-wide) and their layers, and work deferred until every
/// table is in (wall top attachments, annotations).
/// </summary>
static class ImportContext
{
    static readonly HashSet<string> TypeTables =
    [
        "wall_type", "slab_type", "roof_type", "ceiling_type", "door_type", "window_type", "curtain_wall_type",
        "column_type", "beam_type", "foundation_type", "furniture_type", "railing_type",
    ];

    public static Dictionary<string, Dictionary<string, string?>> Types { get; } = new();
    public static Dictionary<string, List<Dictionary<string, string?>>> Layers { get; } = new();

    /// <summary>Every table's rows (stair parts, circuit members, …).</summary>
    public static Dictionary<string, List<Dictionary<string, string?>>> Rows { get; private set; } = new();

    /// <summary>Railings created on a stair: stair element → (railing, side).</summary>
    public static Dictionary<ElementId, List<(ElementId Railing, string Side)>> StairRailings { get; } = new();

    /// <summary>(wall, directory of the wall row, roof / slab id) — attached once roofs and slabs exist.</summary>
    public static List<(ElementId Wall, string Dir, string Target)> PendingAttachments { get; } = [];

    public static void Reset()
    {
        Types.Clear();
        Layers.Clear();
        StairRailings.Clear();
        Rows = new();
        PendingAttachments.Clear();
    }

    /// <summary>
    /// Reads the type tables and fills every typed instance row's empty type
    /// parameters from its type, so the importers see effective values.
    /// </summary>
    public static void Load(Dictionary<string, List<Dictionary<string, string?>>> tableRows)
    {
        Reset();
        Rows = tableRows;
        foreach (var (table, rows) in tableRows)
        {
            if (!TypeTables.Contains(table)) continue;
            foreach (var row in rows)
                if (row.GetValueOrDefault("id") is { } id) Types[id] = row;
        }
        if (tableRows.TryGetValue("type_layer", out var layers))
        {
            foreach (var g in layers.Where(l => l.GetValueOrDefault("type_id") is not null).GroupBy(l => l["type_id"]!))
                Layers[g.Key] = g.OrderBy(l => int.TryParse(l.GetValueOrDefault("seq"), out var s) ? s : 0).ToList();
        }
        foreach (var (table, rows) in tableRows)
        {
            if (!TypeInheritance.TypeParams.ContainsKey(table)) continue;
            foreach (var row in rows)
                if (Type(row.GetValueOrDefault("type_id")) is { } type)
                    TypeInheritance.FillFromType(table, row, type);
        }
    }

    public static Dictionary<string, string?>? Type(string? id) =>
        id is not null && Types.TryGetValue(id, out var t) ? t : null;

    public static IReadOnlyList<Dictionary<string, string?>> LayersOf(string? typeId) =>
        typeId is not null && Layers.TryGetValue(typeId, out var l) ? l : [];
}
