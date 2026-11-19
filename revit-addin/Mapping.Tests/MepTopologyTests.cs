using System.Diagnostics;
using BimDown.RevitAddin.Mapping;
using Xunit;
using Xunit.Abstractions;

namespace BimDown.RevitAddin.Tests;

/// <summary>
/// MEP connections BimDown can't express as Revit reports them, reproduced from the
/// failing rows of the live Revit 2026 sample exports (Snowdon HVAC / Plumbing, JP MEP):
/// run ↔ run joins and taps, hosts on another level with an id the run's own level
/// also uses, connector names out of order, fittings and risers across levels.
/// With BIMDOWN_CLI set the written projects must also pass `bimdown validate`.
/// </summary>
public class MepTopologyTests(ITestOutputHelper output)
{
    static Dictionary<string, string?> Row(params (string Key, object? Value)[] kv) =>
        kv.ToDictionary(p => p.Key, p => p.Value switch { null => null, double d => Names.Num(d, 4), _ => p.Value.ToString() });

    static Dictionary<string, string?> Run(string id, string level, double x0, double y0, double z0, double x1, double y1, double z1,
        string? from, string? to, string system = "SA", string? flexible = null) =>
        Row(("id", id), ("level_id", level), ("start_x", x0), ("start_y", y0), ("start_z", z0), ("end_x", x1), ("end_y", y1), ("end_z", z1),
            ("shape", "round"), ("size_x", 0.15), ("system_type", system), ("from", from), ("to", to), ("flexible", flexible));

    static Dictionary<string, string?> Node(string id, string level, double x, double y, double offset, string? kind = null) =>
        Row(("id", id), ("level_id", level), ("x", x), ("y", y), ("base_offset", offset), ("system_type", "SA"), ("kind", kind));

    static readonly string[] CurveCols = ["id", "number", "shape", "size_x", "size_y", "system_type", "from", "to", "flexible"];
    static readonly string[] HostCols = ["id", "number", "system_type", "kind", "fitting", "terminal_type"];
    static readonly string[] PortCols = ["id", "host_id", "name", "offset_x", "offset_y", "offset_z", "dir_x", "dir_y", "dir_z", "shape", "size_w", "system_type", "flow_dir", "domain"];

    static Dictionary<string, string?> Port(string host, string name, double ox, double oy, double oz, string domain = "hvac") =>
        Row(("id", $"{host}.{name}"), ("host_id", host), ("name", name), ("offset_x", ox), ("offset_y", oy), ("offset_z", oz),
            ("dir_x", 0.0), ("dir_y", 0.0), ("dir_z", 1.0), ("shape", "round"), ("size_w", 0.1), ("flow_dir", "bidirectional"), ("domain", domain));

    /// <summary>Snowdon-like levels, ordered by UniqueId differently from elevation.</summary>
    static List<ExportedTable> Project(params ExportedTable[] extra) =>
    [
        new("level", true, ["id", "number", "name", "elevation"],
        [
            Row(("id", "L1"), ("number", "1"), ("name", "L1"), ("elevation", 0.0)),
            Row(("id", "L2"), ("number", "2"), ("name", "L2"), ("elevation", 2.464)),
            Row(("id", "L3"), ("number", "3"), ("name", "L3"), ("elevation", 5.74)),
            Row(("id", "L4"), ("number", "4"), ("name", "L4"), ("elevation", 9.804)),
        ]),
        new("mep_system", true, ["id", "system_type", "name", "discipline"],
        [
            Row(("id", "SYS-SA"), ("system_type", "SA"), ("name", "Supply Air"), ("discipline", "hvac")),
            Row(("id", "SYS-SAN"), ("system_type", "SAN"), ("name", "Sanitary"), ("discipline", "plumbing")),
        ]),
        .. extra,
    ];

    static string Write(List<ExportedTable> tables, string name)
    {
        var dir = Path.Combine(Path.GetTempPath(), $"bimdown-mep-{name}-{Guid.NewGuid():N}");
        ProjectWriter.WriteProject(dir, tables, new ShortIdGenerator(), name, "test");
        return dir;
    }

    static List<Dictionary<string, string?>> Rows(List<ExportedTable> tables, string table) =>
        tables.Where(t => t.TableName == table).SelectMany(t => t.Rows).ToList();

    static Dictionary<string, string?> ByUid(List<ExportedTable> tables, string table, string uid) =>
        Rows(tables, table).Single(r => r.GetValueOrDefault("_uid") == uid);

    void Validate(string dir)
    {
        var cli = Environment.GetEnvironmentVariable("BIMDOWN_CLI");
        if (string.IsNullOrEmpty(cli) || !File.Exists(cli)) { output.WriteLine("BIMDOWN_CLI not set: skipped `bimdown validate`."); return; }
        using var p = Process.Start(new ProcessStartInfo("node", [cli, "validate", dir]) { RedirectStandardOutput = true, RedirectStandardError = true })!;
        var text = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd();
        p.WaitForExit();
        output.WriteLine(text);
        Assert.True(p.ExitCode == 0, $"bimdown validate failed:\n{text}");
    }

    [Fact]
    public void Flex_duct_onto_a_duct_on_another_level_meets_it_at_a_node()
    {
        // Snowdon HVAC du-6 (flex, level L1, at 8.4 m) ↔ du-89 (L3): from = the other duct.
        var tables = Project(
            new ExportedTable("duct", false, CurveCols,
            [
                Run("FLEX", "L1", 8.13, 5.927, 8.446, 7.95, 5.324, 8.25, "DUCT", "ELB", flexible: "true"),
                Run("DUCT", "L3", 8.13, 6.079, 8.446, 8.13, 5.927, 8.446, "TEE", "FLEX"),
            ]),
            new ExportedTable("mep_node", false, HostCols,
            [
                Node("ELB", "L3", 7.95, 5.324, 8.212 - 5.74),
                Node("TEE", "L3", 8.13, 6.231, 8.445 - 5.74),
            ]));
        var dir = Write(tables, "flex");
        var flex = ByUid(tables, "duct", "FLEX");
        var duct = ByUid(tables, "duct", "DUCT");
        Assert.Equal(flex["from"], duct["to"]);
        var node = Rows(tables, "mep_node").Single(n => n["id"] == flex["from"] && n["level_id"] == "lv-3");
        Assert.Null(node.GetValueOrDefault("fitting"));
        // The flex duct's fitting moved to level 3 with it? No: ELB keeps L3, FLEX (L1) reaches it across levels.
        Assert.DoesNotContain(flex["to"], Rows(tables, "mep_node").Where(n => n["level_id"] == "lv-1").Select(n => n["id"]));
        Validate(dir);
    }

    [Fact]
    public void A_tap_splits_the_main_with_a_tap_node()
    {
        var tables = Project(
            new ExportedTable("duct", false, CurveCols,
            [
                Run("MAIN", "L1", 0, 0, 2.5, 10, 0, 2.5, "N1", "N2"),
                Run("BR1", "L1", 4, 0.1, 2.5, 4, 3, 2.5, "MAIN", "N3"),
                Run("BR2", "L1", 7, -0.1, 2.5, 7, -3, 2.5, "MAIN", "N4"),
            ]),
            new ExportedTable("mep_node", false, HostCols,
            [
                Node("N1", "L1", 0, 0, 2.5), Node("N2", "L1", 10, 0, 2.5), Node("N3", "L1", 4, 3, 2.5), Node("N4", "L1", 7, -3, 2.5),
            ]));
        var dir = Write(tables, "tap");
        var mains = Rows(tables, "duct").Where(r => r["_uid"] == "MAIN" || r["_uid"]!.Contains("MAIN#")).ToList();
        Assert.Equal(3, mains.Count);
        var taps = Rows(tables, "mep_node").Where(n => n.GetValueOrDefault("fitting") == "tap").ToList();
        Assert.Equal(2, taps.Count);
        var br1 = ByUid(tables, "duct", "BR1");
        var tap1 = taps.Single(t => t["id"] == br1["from"]);
        Assert.Equal("4", tap1["x"]);
        // The pieces chain N1 → tap → tap → N2.
        Assert.Equal(2, mains.Count(m => m["from"] == tap1["id"] || m["to"] == tap1["id"]));
        Assert.Equal("4", mains.Single(m => m["_uid"] == "MAIN")["end_x"]);
        Validate(dir);
    }

    [Fact]
    public void A_port_on_another_level_whose_id_the_runs_level_reuses_resolves()
    {
        // Snowdon Plumbing pi-28 (L1).from = "tm-11:out": tm-11 is on L2, and L1 has its own tm-11.
        var tables = Project(
            new ExportedTable("pipe", false, CurveCols,
            [
                Run("P1", "L1", 1, 1, 2.6, 1, 4, 2.6, "WC-UP:out", "N1", "SAN"),
                Run("P2", "L1", 5, 5, 0.4, 5, 8, 0.4, "WC-HERE:out", null, "SAN"),
            ]),
            new ExportedTable("terminal", false, HostCols,
            [
                Row(("id", "WC-HERE"), ("level_id", "L1"), ("x", 5.0), ("y", 5.0), ("base_offset", 0.4), ("system_type", "SAN"), ("terminal_type", "water_closet")),
                Row(("id", "WC-UP"), ("level_id", "L2"), ("x", 1.0), ("y", 1.0), ("base_offset", 0.136), ("system_type", "SAN"), ("terminal_type", "water_closet")),
            ]),
            new ExportedTable("mep_node", false, HostCols, [Node("N1", "L1", 1, 4, 2.6)]),
            new ExportedTable("connector", false, PortCols, [Port("WC-HERE", "out", 0, 0, 0, "piping"), Port("WC-UP", "out", 0, 0, 0, "piping")]));
        var dir = Write(tables, "collision");
        var up = ByUid(tables, "terminal", "WC-UP");
        var here = ByUid(tables, "terminal", "WC-HERE");
        Assert.NotEqual(up["id"], here["id"]);
        Assert.Equal($"{up["id"]}:out", ByUid(tables, "pipe", "P1")["from"]);
        // The target's id is used by nothing else in the project.
        Assert.Single(tables.Where(t => !t.IsGlobal).SelectMany(t => t.Rows), r => r["id"] == up["id"]);
        Validate(dir);
    }

    [Fact]
    public void A_port_name_the_host_lacks_becomes_the_port_the_run_ends_on()
    {
        // Snowdon Plumbing pi-121.to = "tm-19:c1": the pipe ends on tm-19:c0.
        var tables = Project(
            new ExportedTable("pipe", false, CurveCols, [Run("P1", "L2", -9.443, -2.684, 3.378, -9.443, -2.648, 3.378, "N1", "FIX:c1", "SAN")]),
            new ExportedTable("terminal", false, HostCols,
                [Row(("id", "FIX"), ("level_id", "L2"), ("x", -9.4), ("y", -2.6), ("base_offset", 0.9), ("rotation", 90.0), ("system_type", "SAN"))]),
            new ExportedTable("mep_node", false, HostCols, [Node("N1", "L2", -9.443, -2.684, 0.914)]),
            new ExportedTable("connector", false, PortCols,
                [Port("FIX", "c0", -0.048, 0.043, 0.014, "piping"), Port("FIX", "in", 0.5, 0, 0.5, "piping")]));
        var dir = Write(tables, "ports");
        Assert.EndsWith(":c0", ByUid(tables, "pipe", "P1")["to"]);
        Validate(dir);
    }

    [Fact]
    public void Fittings_and_accessories_on_another_level_move_to_their_runs()
    {
        // JP MEP: pipes on B1 between fittings Revit put on 1F; a valve (ports) too.
        var tables = Project(
            new ExportedTable("pipe", false, CurveCols,
            [
                Run("P1", "L1", 0, 0, 1, 3, 0, 1, "ELB", "VLV:in"),
                Run("P2", "L1", 3.2, 0, 1, 6, 0, 1, "VLV:out", null),
            ]),
            new ExportedTable("mep_node", false, HostCols,
            [
                Node("ELB", "L3", 0, 0, 1 - 5.74),
                Node("VLV", "L2", 3.1, 0, 1 - 2.464, "gate_valve"),
                Node("OTHER", "L1", 9, 9, 1),
            ]),
            new ExportedTable("connector", false, PortCols, [Port("VLV", "in", -0.1, 0, 0, "piping"), Port("VLV", "out", 0.1, 0, 0, "piping")]));
        var dir = Write(tables, "moved");
        var elb = ByUid(tables, "mep_node", "ELB");
        Assert.Equal("lv-1", elb["level_id"]);
        Assert.Equal("1", elb["base_offset"]);
        Assert.Equal("lv-1", ByUid(tables, "mep_node", "VLV")["level_id"]);
        Assert.All(Rows(tables, "connector"), c => Assert.Equal("lv-1", c["level_id"]));
        Validate(dir);
    }

    [Fact]
    public void A_riser_through_the_next_floor_is_split_there_with_a_node_on_the_upper_level()
    {
        // Snowdon HVAC du-170 (L2, 2.46 → 8.74 m) ends on a fitting on L3 (5.74).
        var tables = Project(
            new ExportedTable("duct", false, CurveCols,
            [
                Run("RISER", "L2", -5.891, -4.307, 2.464, -5.891, -4.307, 8.74, "BOT", "TOP"),
                Run("D1", "L2", 0, 0, 2.464, 1, 0, 2.464, "X1", "X2"),
                Run("D2", "L3", 2, 0, 5.74, 3, 0, 5.74, "X3", null),
            ]),
            new ExportedTable("mep_node", false, HostCols,
            [
                Node("BOT", "L2", -5.891, -4.307, 0),
                Node("TOP", "L3", -5.891, -4.307, 3.0),
                // Ids the level below also uses: the riser node must not collide.
                Node("X1", "L2", 0, 0, 0), Node("X2", "L2", 1, 0, 0), Node("X3", "L3", 2, 0, 0),
            ]));
        var dir = Write(tables, "riser");
        var lower = ByUid(tables, "duct", "RISER");
        var upper = Rows(tables, "duct").Single(r => r["_uid"]!.StartsWith(MepTopology.SynthPrefix));
        Assert.Equal("lv-2", lower["level_id"]);
        Assert.Equal("lv-3", upper["level_id"]);
        Assert.Equal("5.74", lower["end_z"]);
        Assert.Equal("5.74", upper["start_z"]);
        var node = Rows(tables, "mep_node").Single(n => n["id"] == lower["to"]);
        Assert.Equal("lv-3", node["level_id"]);
        Assert.Equal("0", node["base_offset"]);
        Assert.Equal(node["id"], upper["from"]);
        Assert.Equal(ByUid(tables, "mep_node", "TOP")["id"], upper["to"]);
        // Nothing on level 2 takes the riser node's id; synthesized rows stay out of _IdMap.
        Assert.DoesNotContain(Rows(tables, "mep_node"), n => n["level_id"] == "lv-2" && n["id"] == node["id"]);
        Assert.DoesNotContain(MepTopology.SynthPrefix, File.ReadAllText(Path.Combine(dir, "_IdMap.csv")));
        Validate(dir);
    }

    [Fact]
    public void A_terminal_without_a_level_goes_to_the_level_below_it()
    {
        // Snowdon HVAC global/tm-5 (exhaust cap, no level, written at z 0) on an L4 duct at 12.89 m.
        var tables = Project(
            new ExportedTable("duct", false, CurveCols, [Run("D", "L4", 10.97, -8.3, 12.89, 10.973, -9.508, 12.891, "N", "CAP:domestic_exhaust")]),
            new ExportedTable("terminal", false, HostCols,
                [Row(("id", "CAP"), ("x", 10.973), ("y", -9.502), ("_z", 12.891), ("rotation", 90.0), ("system_type", "SA"))]),
            new ExportedTable("mep_node", false, HostCols, [Node("N", "L4", 10.97, -8.3, 12.89 - 9.804)]),
            new ExportedTable("connector", false, PortCols, [Port("CAP", "domestic_exhaust", -0.006, 0, 0)]));
        var dir = Write(tables, "levelless");
        var cap = ByUid(tables, "terminal", "CAP");
        Assert.Equal("lv-4", cap["level_id"]);
        Assert.Equal("3.087", cap["base_offset"]);
        Assert.Equal("lv-4", Rows(tables, "connector").Single()["level_id"]);
        Validate(dir);
    }
}
