using Autodesk.Revit.DB;

namespace BimDown.RevitAddin;

class ShortIdGenerator
{
    static readonly Dictionary<string, string> PrefixMap = new()
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
        ["structure_wall"] = "sw",
        ["structure_column"] = "sc",
        ["structure_slab"] = "ss",
        ["beam"] = "bm",
        ["brace"] = "br",
        ["foundation"] = "f",
        ["duct"] = "du",
        ["pipe"] = "pi",
        ["cable_tray"] = "ct",
        ["conduit"] = "co",
        ["equipment"] = "eq",
        ["terminal"] = "tm",
        ["mep_node"] = "mn",
        ["roof"] = "ro",
        ["ceiling"] = "cl",
        ["opening"] = "op",
        ["mesh"] = "ms",
        ["curtain_wall"] = "cw",
        ["ramp"] = "rp",
        ["railing"] = "rl",
        ["room_separator"] = "rs",
    };

    // References that point at level rows (global, assigned first). Resolved early so
    // partition directories can be derived from the short level id.
    static readonly string[] LevelReferenceFields = ["level_id", "base_level_id", "top_level_id"];
    // References that may point at any partitioned table. Resolved last, after every
    // id has been assigned, so forward references (e.g. opening → structure_wall,
    // duct → mep_node) resolve instead of nulling out.
    static readonly string[] OtherReferenceFields = ["host_id"];
    // Port references: "host_uid:port_name" or bare "host_uid". Only the host_uid
    // is resolved to a short id; the port_name suffix is preserved.
    static readonly string[] PortReferenceFields = ["from", "to"];
    static readonly string[] ReferenceFields = [.. LevelReferenceFields, .. OtherReferenceFields];

    // Counters scoped by (directory, prefix)
    readonly Dictionary<string, Dictionary<string, int>> _dirCounters = new();
    readonly Dictionary<string, string> _uidToShort = new();
    // Track directory for each short ID (for _IdMap)
    readonly Dictionary<string, string> _shortToDir = new();
    // Per directory: short id -> owning uid. Lets the counter skip ids already
    // claimed (e.g. seeded from stale BimDown_Id tags) while staying idempotent for
    // repeat calls with the same uid.
    readonly Dictionary<string, Dictionary<string, string>> _usedByDir = new();

    internal void SeedFromModel(IList<Element> elements)
    {
        foreach (var element in elements)
        {
            var shortId = BimDownParameter.Get(element);
            if (shortId is null) continue;

            _uidToShort[element.UniqueId] = shortId;

            // We don't know the directory at seed time — counters will be
            // re-established when GetOrAssign is called with directory info.
            // For now, track the max counter globally to avoid collisions
            // during the transition from old (global) to new (scoped) IDs.
        }
    }

    internal string GetOrAssign(string tableName, string uniqueId, string directory = "global")
    {
        if (!_usedByDir.TryGetValue(directory, out var used))
        {
            used = new Dictionary<string, string>();
            _usedByDir[directory] = used;
        }

        // Reuse a previously assigned/seeded id: claim it if free here, return it if we
        // already own it (idempotent), or fall through to reassign if another element in
        // this directory already took it (e.g. a stale duplicate BimDown_Id tag).
        if (_uidToShort.TryGetValue(uniqueId, out var existing))
        {
            if (!used.TryGetValue(existing, out var owner))
            {
                used[existing] = uniqueId;
                _shortToDir[existing] = directory;
                return existing;
            }
            if (owner == uniqueId)
                return existing;
        }

        var prefix = PrefixMap[tableName];

        if (!_dirCounters.TryGetValue(directory, out var counters))
        {
            counters = new Dictionary<string, int>();
            _dirCounters[directory] = counters;
        }

        string shortId;
        do
        {
            counters.TryGetValue(prefix, out var counter);
            counter++;
            counters[prefix] = counter;
            shortId = $"{prefix}-{counter}";
        } while (used.ContainsKey(shortId));

        used[shortId] = uniqueId;
        _uidToShort[uniqueId] = shortId;
        _shortToDir[shortId] = directory;
        return shortId;
    }

    internal string? Resolve(string? uniqueId)
    {
        if (uniqueId is null) return null;
        return _uidToShort.GetValueOrDefault(uniqueId);
    }

    /// <summary>
    /// Remaps rows for global tables (level, grid). IDs are scoped to "global".
    /// </summary>
    internal void RemapGlobalRows(string tableName, List<Dictionary<string, string?>> rows)
    {
        foreach (var row in rows)
        {
            var uid = row.GetValueOrDefault("id");
            if (uid is not null)
                row["id"] = GetOrAssign(tableName, uid, "global");

            ResolveReferences(row);
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
            var dir = getDirectory(row);
            var uid = row.GetValueOrDefault("id");
            if (uid is not null)
                row["id"] = GetOrAssign(tableName, uid, dir);

            ResolveReferences(row);
        }
    }

    void ResolveReferences(Dictionary<string, string?> row)
    {
        ResolveReferences(row, ReferenceFields);
        ResolvePortReferences(row);
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

    /// <summary>Assigns a short id to a single row (no reference resolution).</summary>
    internal void AssignRowId(string tableName, Dictionary<string, string?> row, string directory)
    {
        var uid = row.GetValueOrDefault("id");
        if (uid is not null)
            row["id"] = GetOrAssign(tableName, uid, directory);
    }

    /// <summary>Resolves level references (level_id, base_level_id, top_level_id) only.</summary>
    internal void ResolveLevelReferences(Dictionary<string, string?> row) =>
        ResolveReferences(row, LevelReferenceFields);

    /// <summary>Resolves non-level references (host_id and port refs from/to) only.</summary>
    internal void ResolveOtherReferences(Dictionary<string, string?> row)
    {
        ResolveReferences(row, OtherReferenceFields);
        ResolvePortReferences(row);
    }

    /// <summary>
    /// Returns all mappings with directory info for _IdMap.csv.
    /// </summary>
    internal IReadOnlyDictionary<string, string> Mappings => _uidToShort;

    internal string GetDirectory(string shortId) =>
        _shortToDir.GetValueOrDefault(shortId, "global");
}
