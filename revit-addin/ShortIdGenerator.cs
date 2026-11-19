using BimDown.RevitAddin.Mapping;

namespace BimDown.RevitAddin;

/// <summary>
/// Maps Revit UniqueIds to BimDown short ids (<c>{prefix}-{n}</c>, level-scoped
/// counters; type tables get readable <c>{prefix}-{slug of the type name}</c>
/// ids) and rewrites the reference fields of exported rows. Pure (no Revit API):
/// seeding from the BimDown_Id parameter happens in ExportPipeline.
/// </summary>
class ShortIdGenerator
{
    internal static readonly Dictionary<string, string> PrefixMap = new()
    {
        ["level"] = "lv",
        ["grid"] = "gr",
        ["wall"] = "w",
        ["column"] = "c",
        ["slab"] = "sl",
        ["space"] = "sp",
        ["door"] = "d",
        ["window"] = "wn",
        ["stair"] = "st",
        ["stair_run"] = "sr",
        ["stair_landing"] = "sl_land",
        ["structure_wall"] = "sw",
        ["structure_column"] = "sc",
        ["structure_slab"] = "ss",
        ["beam"] = "bm",
        ["brace"] = "br",
        ["foundation"] = "f",
        ["beam_system"] = "bs",
        ["duct"] = "du",
        ["pipe"] = "pi",
        ["cable_tray"] = "ct",
        ["conduit"] = "co",
        ["equipment"] = "eq",
        ["terminal"] = "tm",
        ["mep_node"] = "mn",
        ["connector"] = "cn",
        ["circuit"] = "ci",
        ["mep_system"] = "sys",
        ["roof"] = "ro",
        ["ceiling"] = "cl",
        ["opening"] = "op",
        ["mesh"] = "ms",
        ["curtain_wall"] = "cw",
        ["ramp"] = "rp",
        ["railing"] = "rl",
        ["room_separator"] = "rs",
        ["furniture"] = "fu",
        ["model_group"] = "mg",
        ["dimension"] = "dm",
        ["text_note"] = "tx",
        ["tag"] = "tg",
        // Element types (global/) and layers
        ["wall_type"] = "wt",
        ["slab_type"] = "slt",
        ["roof_type"] = "rot",
        ["ceiling_type"] = "clt",
        ["door_type"] = "dt",
        ["window_type"] = "wnt",
        ["curtain_wall_type"] = "cwt",
        ["column_type"] = "colt",
        ["beam_type"] = "bmt",
        ["foundation_type"] = "fdt",
        ["furniture_type"] = "fut",
        ["railing_type"] = "rlt",
        ["type_layer"] = "tl",
    };

    /// <summary>Tables whose ids are slugs of the row's name (wt-basic-wall-generic-200mm).</summary>
    static readonly HashSet<string> SlugTables =
    [
        "wall_type", "slab_type", "roof_type", "ceiling_type", "door_type", "window_type", "curtain_wall_type",
        "column_type", "beam_type", "foundation_type", "furniture_type", "railing_type",
    ];

    // References that point at level rows (global, assigned first). Resolved early so
    // partition directories can be derived from the short level id.
    static readonly string[] LevelReferenceFields = ["level_id", "base_level_id", "top_level_id", "multistory_top_level_id"];
    // References that may point at any table. Resolved last, after every id has been
    // assigned, so forward references (opening → structure_wall, duct → mep_node,
    // wall → roof it attaches to) resolve instead of nulling out.
    static readonly string[] OtherReferenceFields = ["host_id", "type_id", "top_attach_id", "beam_system_id", "circuit_id", "group_id"];
    // Port references: "host_uid:port_name" or bare "host_uid". Only the host_uid
    // is resolved to a short id; the port_name suffix is preserved.
    static readonly string[] PortReferenceFields = ["from", "to"];

    // Counters scoped by (directory, prefix)
    readonly Dictionary<string, Dictionary<string, int>> _dirCounters = new();
    readonly Dictionary<string, string> _uidToShort = new();
    // Track directory for each short ID (for _IdMap)
    readonly Dictionary<string, string> _shortToDir = new();
    // Directory per assigned uid (short ids repeat across level directories)
    readonly Dictionary<string, string> _uidToDir = new();
    // Per directory: short id -> owning uid. Lets the counter skip ids already
    // claimed (e.g. seeded from stale BimDown_Id tags) while staying idempotent for
    // repeat calls with the same uid.
    readonly Dictionary<string, Dictionary<string, string>> _usedByDir = new();

    /// <summary>Seeds a previously written short id (the element's BimDown_Id parameter).</summary>
    internal void Seed(string uniqueId, string shortId) => _uidToShort[uniqueId] = shortId;

    // Ids taken project-wide: cross-level targets (no other directory may use them) and,
    // per id, every uid holding it in some directory.
    readonly Dictionary<string, string> _uniqueOwner = new();
    readonly Dictionary<string, HashSet<string>> _owners = new();

    /// <param name="unique">The id must be used by no other element in any directory
    /// (a host that runs on other levels reference: the riser rule finds exactly it).</param>
    internal string GetOrAssign(string tableName, string uniqueId, string directory = "global", string? nameHint = null, bool unique = false)
    {
        if (!_usedByDir.TryGetValue(directory, out var used))
        {
            used = new Dictionary<string, string>();
            _usedByDir[directory] = used;
        }

        var prefix = PrefixMap.TryGetValue(tableName, out var p) ? p : tableName;

        bool Taken(string id) =>
            (used.TryGetValue(id, out var owner) && owner != uniqueId)
            || (_uniqueOwner.TryGetValue(id, out var u) && u != uniqueId)
            || (unique && _owners.TryGetValue(id, out var all) && all.Any(o => o != uniqueId));

        // Reuse a previously assigned/seeded id: return it if we already own it here
        // (idempotent), claim it if free, or fall through to reassign if another element
        // took it (e.g. a stale duplicate BimDown_Id tag) or the element moved to a table
        // with another prefix (wall ↔ structure_wall).
        if (_uidToShort.TryGetValue(uniqueId, out var existing) && existing.StartsWith(prefix + "-", StringComparison.Ordinal))
        {
            if (used.TryGetValue(existing, out var owner) && owner == uniqueId)
                return existing;
            if (!Taken(existing))
                return Claim(existing);
        }

        string shortId;
        if (SlugTables.Contains(tableName) && !string.IsNullOrWhiteSpace(nameHint))
        {
            var stem = $"{prefix}-{Names.Slug(nameHint)}";
            shortId = stem;
            for (var n = 2; Taken(shortId); n++) shortId = $"{stem}-{n}";
        }
        else
        {
            if (!_dirCounters.TryGetValue(directory, out var counters))
            {
                counters = new Dictionary<string, int>();
                _dirCounters[directory] = counters;
            }
            do
            {
                counters.TryGetValue(prefix, out var counter);
                counter++;
                counters[prefix] = counter;
                shortId = $"{prefix}-{counter}";
            } while (Taken(shortId));
        }
        return Claim(shortId);

        string Claim(string id)
        {
            used[id] = uniqueId;
            if (!_owners.TryGetValue(id, out var all)) _owners[id] = all = [];
            all.Add(uniqueId);
            if (unique) _uniqueOwner[id] = uniqueId;
            _uidToShort[uniqueId] = id;
            _shortToDir[id] = directory;
            _uidToDir[uniqueId] = directory;
            return id;
        }
    }

    internal string? Resolve(string? uniqueId)
    {
        if (uniqueId is null) return null;
        // Only ids assigned in this export: a seeded id of an element that was not
        // exported (filtered out, table disabled) would be a dangling reference.
        return _uidToDir.ContainsKey(uniqueId) ? _uidToShort[uniqueId] : null;
    }

    /// <summary>Remaps rows for global tables (level, grid, types). IDs are scoped to "global".</summary>
    internal void RemapGlobalRows(string tableName, List<Dictionary<string, string?>> rows)
    {
        foreach (var row in rows)
        {
            AssignRowId(tableName, row, "global");
            ResolveLevelReferences(row);
            ResolveOtherReferences(row);
        }
    }

    /// <summary>
    /// Remaps rows for level-partitioned tables. Each row's directory is determined
    /// by the provided function (uses GetPartitionDir logic).
    /// </summary>
    internal void RemapPartitionedRows(string tableName, List<Dictionary<string, string?>> rows,
        Func<Dictionary<string, string?>, string> getDirectory)
    {
        foreach (var row in rows)
        {
            AssignRowId(tableName, row, getDirectory(row));
            ResolveLevelReferences(row);
            ResolveOtherReferences(row);
        }
    }

    void ResolveReferences(Dictionary<string, string?> row, string[] fields)
    {
        foreach (var field in fields)
        {
            var refUid = row.GetValueOrDefault(field);
            if (refUid is not null)
                row[field] = Resolve(refUid);
        }
    }

    /// <summary>Resolves port-ref fields ("from", "to"). Splits "host_uid:port_name"
    /// and only remaps the host_uid; bare values are remapped directly.</summary>
    void ResolvePortReferences(Dictionary<string, string?> row)
    {
        foreach (var field in PortReferenceFields)
        {
            var val = row.GetValueOrDefault(field);
            if (string.IsNullOrEmpty(val)) continue;
            var colon = val.IndexOf(':');
            if (colon < 0)
            {
                row[field] = Resolve(val);
            }
            else
            {
                var host = val[..colon];
                var port = val[(colon + 1)..];
                var shortHost = Resolve(host);
                row[field] = shortHost is null ? null : $"{shortHost}:{port}";
            }
        }
    }

    /// <summary>
    /// boundary_walls is a ';'-separated id list: every id must resolve, otherwise the
    /// association is dropped (with its face and offset) and the polygon stays sketched.
    /// </summary>
    void ResolveListReferences(Dictionary<string, string?> row)
    {
        var val = row.GetValueOrDefault("boundary_walls");
        if (string.IsNullOrEmpty(val)) return;
        var ids = val.Split(';').Select(Resolve).ToList();
        if (ids.Any(id => id is null))
        {
            row["boundary_walls"] = null;
            row["boundary_face"] = null;
            row["boundary_offset"] = null;
        }
        else row["boundary_walls"] = string.Join(";", ids);
    }

    /// <summary>Assigns a short id to a single row (no reference resolution).</summary>
    internal void AssignRowId(string tableName, Dictionary<string, string?> row, string directory, bool unique = false)
    {
        var uid = row.GetValueOrDefault("id");
        if (uid is null) return;
        row["_uid"] = uid;
        row["id"] = GetOrAssign(tableName, uid, directory, row.GetValueOrDefault("name"), unique);
    }

    /// <summary>Resolves level references (level_id, base_level_id, top_level_id, multistory_top_level_id) only.</summary>
    internal void ResolveLevelReferences(Dictionary<string, string?> row) =>
        ResolveReferences(row, LevelReferenceFields);

    /// <summary>Resolves non-level references (host_id, type_id, …, port refs from/to, boundary_walls).</summary>
    internal void ResolveOtherReferences(Dictionary<string, string?> row)
    {
        ResolveReferences(row, OtherReferenceFields);
        ResolvePortReferences(row);
        ResolveListReferences(row);
    }

    /// <summary>
    /// Returns all mappings with directory info for _IdMap.csv. Rows the exporter
    /// synthesized (MEP nodes, split runs) have no Revit element: left out.
    /// </summary>
    internal IReadOnlyDictionary<string, string> Mappings =>
        _uidToShort.Where(kv => _uidToDir.ContainsKey(kv.Key) && !MepTopology.IsSynthetic(kv.Key)).ToDictionary(kv => kv.Key, kv => kv.Value);

    internal string GetDirectory(string shortId) =>
        _shortToDir.GetValueOrDefault(shortId, "global");

    /// <summary>Directory the element with this uid was exported to.</summary>
    internal string GetDirectoryOfUid(string uniqueId) =>
        _uidToDir.GetValueOrDefault(uniqueId, "global");
}
