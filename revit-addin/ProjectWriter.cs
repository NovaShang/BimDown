using System.Globalization;
using BimDown.RevitAddin.Geojson;
using BimDown.RevitAddin.Mapping;

namespace BimDown.RevitAddin;

/// <summary>The rows exported for one BimDown table (Revit UniqueIds until <see cref="ProjectWriter.AssignIds"/>).</summary>
record ExportedTable(string TableName, bool IsGlobal, IReadOnlyList<string> CsvColumns, List<Dictionary<string, string?>> Rows);

/// <summary>
/// Pure tail of the export pipeline: type inheritance, short ids, level
/// partitioning and writing CSV / GeoJSON / metadata. No Revit API, so the
/// mapping unit tests write real projects with it and run <c>bimdown validate</c>.
/// </summary>
static class ProjectWriter
{
    /// <summary>
    /// Element types: instance values equal to their type's are blanked (they
    /// inherit), and types / layers no exported instance uses are dropped.
    /// Runs before id assignment (type_id still holds Revit UniqueIds).
    /// </summary>
    internal static void ApplyTypes(List<ExportedTable> tables)
    {
        var byName = tables.GroupBy(t => t.TableName).ToDictionary(g => g.Key, g => g.SelectMany(t => t.Rows).ToList());
        var used = new HashSet<string>();
        foreach (var (instanceTable, typeTable) in TypeInheritance.TypeTableOf)
        {
            if (!byName.TryGetValue(instanceTable, out var rows)) continue;
            var types = byName.GetValueOrDefault(typeTable)?
                .Where(r => r.GetValueOrDefault("id") is not null)
                .GroupBy(r => r["id"]!).ToDictionary(g => g.Key, g => g.First())
                ?? new Dictionary<string, Dictionary<string, string?>>();
            // A type_id pointing at no exported type is dropped (keeps the instance values).
            foreach (var row in rows)
                if (row.GetValueOrDefault("type_id") is { } tid && !types.ContainsKey(tid)) row["type_id"] = null;
            TypeInheritance.StripInherited(instanceTable, rows, types);
            used.UnionWith(TypeInheritance.UsedTypeIds(rows));
        }
        // beam_system rows reference a beam_type too
        if (byName.TryGetValue("beam_system", out var systems)) used.UnionWith(TypeInheritance.UsedTypeIds(systems));

        var typeTables = TypeInheritance.TypeTableOf.Values.ToHashSet();
        foreach (var t in tables.Where(t => typeTables.Contains(t.TableName)))
            t.Rows.RemoveAll(r => r.GetValueOrDefault("id") is not { } id || !used.Contains(id));
        foreach (var t in tables.Where(t => t.TableName == "type_layer"))
            t.Rows.RemoveAll(r => r.GetValueOrDefault("type_id") is not { } id || !used.Contains(id));
        tables.RemoveAll(t => t.Rows.Count == 0);
    }

    /// <summary>
    /// Assigns short ids in passes so references resolve regardless of table order:
    /// 1. global ids (level, grid, types); 2. level references (→ partitioning);
    /// 3. partitioned ids using the resolved level directory; 4. other references.
    /// Returns the level index (level id → elevation rank).
    /// </summary>
    internal static Dictionary<string, int> AssignIds(List<ExportedTable> tables, ShortIdGenerator idGen)
    {
        PlaceConnectorsWithHosts(tables);
        foreach (var t in tables.Where(t => t.IsGlobal))
            foreach (var row in t.Rows)
                idGen.AssignRowId(t.TableName, row, "global");
        foreach (var t in tables)
            foreach (var row in t.Rows)
                idGen.ResolveLevelReferences(row);
        var levelIndex = BuildLevelIndex(tables);
        foreach (var t in tables.Where(t => !t.IsGlobal))
            foreach (var row in t.Rows)
                idGen.AssignRowId(t.TableName, row, GetPartitionDir(row, levelIndex));
        DropUnplaceableTags(tables, levelIndex);
        foreach (var t in tables)
            foreach (var row in t.Rows)
                idGen.ResolveOtherReferences(row);
        return levelIndex;
    }

    /// <summary>
    /// A connector lives in its host's directory (port references "host:port" resolve
    /// there): take the host row's level span, whatever Revit reports on the connector's
    /// family instance (face-hosted terminals have no LevelId but a schedule level).
    /// </summary>
    static void PlaceConnectorsWithHosts(List<ExportedTable> tables)
    {
        var connectors = tables.Where(t => t.TableName == "connector").SelectMany(t => t.Rows).ToList();
        if (connectors.Count == 0) return;
        var hosts = new Dictionary<string, Dictionary<string, string?>>();
        foreach (var t in tables.Where(t => t.TableName != "connector"))
            foreach (var r in t.Rows)
                if (r.GetValueOrDefault("id") is { } id) hosts.TryAdd(id, r);
        foreach (var c in connectors)
        {
            if (c.GetValueOrDefault("host_id") is not { } hid || !hosts.TryGetValue(hid, out var host)) continue;
            c["level_id"] = host.GetValueOrDefault("level_id");
            c["top_level_id"] = host.GetValueOrDefault("top_level_id");
        }
        // Ports of elements no table exported (e.g. a device filtered out as furniture)
        // would be written with an empty host_id.
        foreach (var t in tables.Where(t => t.TableName == "connector"))
            t.Rows.RemoveAll(c => c.GetValueOrDefault("host_id") is not { } hid || !hosts.ContainsKey(hid));
        tables.RemoveAll(t => t.Rows.Count == 0);
    }

    /// <summary>
    /// Consistency fixes that need the final directories: elements in global/
    /// cannot be grouped, and a model group without members is dropped.
    /// </summary>
    internal static void Finalize(List<ExportedTable> tables, Dictionary<string, int> levelIndex)
    {
        var members = new HashSet<string>();
        foreach (var t in tables.Where(t => !t.IsGlobal && t.TableName != "model_group"))
        {
            foreach (var row in t.Rows)
            {
                if (row.GetValueOrDefault("group_id") is not { } gid) continue;
                var dir = GetPartitionDir(row, levelIndex);
                if (dir == "global") row["group_id"] = null;
                else members.Add($"{dir}/{gid}");
            }
        }
        foreach (var t in tables.Where(t => t.TableName == "model_group"))
            t.Rows.RemoveAll(r => !members.Contains($"{GetPartitionDir(r, levelIndex)}/{r.GetValueOrDefault("id")}"));

        // Sizes Revit reports as 0 (a flat 2D family, a roof whose thickness varies, an
        // instance whose size lives on its type): empty, so the value inherits from the type.
        foreach (var row in tables.SelectMany(t => t.Rows))
            foreach (var field in PositiveFields)
                if (row.GetValueOrDefault(field) is { } v && Names.Parse(v) is { } d && !(d > 0)) row[field] = null;

        tables.RemoveAll(t => t.Rows.Count == 0);
    }

    /// <summary>Numeric fields the format requires to be greater than 0 when set.</summary>
    static readonly string[] PositiveFields =
    [
        "thickness", "width", "height", "size_x", "size_y", "flange", "web", "step_count",
        "u_spacing", "v_spacing", "mullion_width", "mullion_depth", "frame_width",
        "baluster_spacing", "baluster_size", "top_rail_size",
    ];

    /// <summary>
    /// A tag needs its host on its own level or in global/: drop tags of elements that were
    /// not exported, or that sit on another storey (seen from this plan, e.g. a slab below).
    /// </summary>
    static void DropUnplaceableTags(List<ExportedTable> tables, Dictionary<string, int> levelIndex)
    {
        // Runs after the short ids are assigned and before references are: host_id is still
        // a Revit UniqueId, the hosts' own UniqueIds are kept in "_uid".
        var tags = tables.Where(t => t.TableName == "tag").ToList();
        if (tags.Count == 0) return;
        var dirOf = new Dictionary<string, string>();
        foreach (var t in tables.Where(t => t.TableName != "tag"))
            foreach (var r in t.Rows)
                if ((r.GetValueOrDefault("_uid") ?? r.GetValueOrDefault("id")) is { } uid)
                    dirOf.TryAdd(uid, t.IsGlobal ? "global" : GetPartitionDir(r, levelIndex));
        foreach (var t in tags)
            t.Rows.RemoveAll(r => r.GetValueOrDefault("host_id") is not { Length: > 0 } host
                                  || !dirOf.TryGetValue(host, out var hostDir)
                                  || (hostDir != "global" && hostDir != GetPartitionDir(r, levelIndex)));
        tables.RemoveAll(t => t.Rows.Count == 0);
    }

    internal static Dictionary<string, int> BuildLevelIndex(List<ExportedTable> tables)
    {
        var levelIndex = new Dictionary<string, int>();
        var levels = tables.Where(t => t.TableName == "level").SelectMany(t => t.Rows)
            .Where(r => r.GetValueOrDefault("id") is not null && Names.Parse(r.GetValueOrDefault("elevation")) is not null)
            .OrderBy(r => Names.Parse(r["elevation"])!.Value)
            .ToList();
        for (var i = 0; i < levels.Count; i++)
            levelIndex[levels[i]["id"]!] = i;
        return levelIndex;
    }

    /// <summary>
    /// Directory of a row: its level, or global/ when it has no level or spans more
    /// than one storey (top level more than one above the base).
    /// </summary>
    internal static string GetPartitionDir(Dictionary<string, string?> row, Dictionary<string, int> levelIndex)
    {
        var levelId = row.GetValueOrDefault("level_id");
        var topLevelId = row.GetValueOrDefault("top_level_id");

        var isMultiStory = false;
        if (levelId is not null && topLevelId is not null
            && levelIndex.TryGetValue(levelId, out var baseIdx)
            && levelIndex.TryGetValue(topLevelId, out var topIdx))
        {
            isMultiStory = topIdx - baseIdx > 1;
        }
        // Shafts span storeys but are level-anchored openings: keep them on their level.
        if (row.GetValueOrDefault("_keep_level") == "true") isMultiStory = false;

        return (isMultiStory || levelId is null || !levelIndex.ContainsKey(levelId)) ? "global" : levelId;
    }

    internal static void WriteCsvs(string outputDir, List<ExportedTable> tables, Dictionary<string, int> levelIndex)
    {
        var groups = new Dictionary<(string Dir, string Table), (IReadOnlyList<string> Columns, List<Dictionary<string, string?>> Rows)>();
        foreach (var t in tables)
        {
            foreach (var row in t.Rows)
            {
                var dir = t.IsGlobal ? "global" : GetPartitionDir(row, levelIndex);
                if (!groups.TryGetValue((dir, t.TableName), out var g))
                {
                    g = (t.CsvColumns, []);
                    groups[(dir, t.TableName)] = g;
                }
                g.Rows.Add(row);
            }
        }
        foreach (var ((dir, table), (columns, rows)) in groups)
        {
            var d = Path.Combine(outputDir, dir);
            Directory.CreateDirectory(d);
            CsvWriter.Write(Path.Combine(d, $"{table}.csv"), DropEmptyOptionalColumns(columns, rows), rows);
        }
    }

    // Always-kept columns; any other column that is empty in every row is left out
    // of the CSV (keeps exports small and readable — empty and missing read the same).
    static readonly HashSet<string> KeptColumns = ["id", "number", "name", "elevation", "thickness", "width", "shape", "host_id", "position", "x", "y", "roof_type", "family", "type_id", "seq", "function", "material", "text", "spacing", "system_type", "start_x", "start_y", "end_x", "end_y"];

    static IReadOnlyList<string> DropEmptyOptionalColumns(IReadOnlyList<string> columns, List<Dictionary<string, string?>> rows) =>
        columns.Where(c => KeptColumns.Contains(c) || rows.Any(r => !string.IsNullOrEmpty(r.GetValueOrDefault(c)))).ToList();

    internal static void WriteIdMap(string outputDir, ShortIdGenerator idGen)
    {
        var idMapRows = idGen.Mappings.Select(kvp => new Dictionary<string, string?>
        {
            ["id"] = kvp.Value,
            ["uuid"] = kvp.Key,
            ["directory"] = idGen.GetDirectoryOfUid(kvp.Key),
        }).ToList();
        CsvWriter.Write(Path.Combine(outputDir, "_IdMap.csv"), ["id", "uuid", "directory"], idMapRows);
    }

    internal static void WriteGeometry(string outputDir, List<ExportedTable> tables, Dictionary<string, int> levelIndex)
    {
        var levelRows = tables.Where(t => t.TableName == "level").SelectMany(t => t.Rows).ToList();
        if (levelRows.Count == 0) return;

        // Partition rows like the CSVs so geometry lands next to them (level dir or global/).
        var partitioned = new List<(string TableName, List<Dictionary<string, string?>> Rows)>();
        foreach (var t in tables)
        {
            if (t.IsGlobal) continue;
            foreach (var g in t.Rows.GroupBy(r => GetPartitionDir(r, levelIndex)))
            {
                var groupRows = g.ToList();
                // GeoJsonWriter groups by level_id = directory name. Rows are not used afterwards.
                foreach (var row in groupRows) row["level_id"] = g.Key;
                partitioned.Add((t.TableName, groupRows));
            }
        }
        GeoJsonWriter.WriteAll(outputDir, partitioned, levelRows);
    }

    internal static void WriteMetadata(string outputDir, string projectName, string source)
    {
        var metadata = new Dictionary<string, object>
        {
            ["format_version"] = 2,
            ["project_name"] = projectName,
            ["units"] = "m",
            ["source"] = source,
        };
        var json = System.Text.Json.JsonSerializer.Serialize(metadata,
            new System.Text.Json.JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(Path.Combine(outputDir, "project_metadata.json"), json);
    }

    /// <summary>Runs every pure step and writes the project (used by tests and the pipeline).</summary>
    internal static void WriteProject(string outputDir, List<ExportedTable> tables, ShortIdGenerator idGen,
        string projectName, string source)
    {
        ApplyTypes(tables);
        var levelIndex = AssignIds(tables, idGen);
        Finalize(tables, levelIndex);
        Directory.CreateDirectory(outputDir);
        WriteCsvs(outputDir, tables, levelIndex);
        WriteIdMap(outputDir, idGen);
        WriteGeometry(outputDir, tables, levelIndex);
        WriteMetadata(outputDir, projectName, source);
    }

    internal static string Invariant(int v) => v.ToString(CultureInfo.InvariantCulture);
}
