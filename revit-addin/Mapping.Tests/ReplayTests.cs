using System.Text.Json;
using Xunit;
using Xunit.Abstractions;

namespace BimDown.RevitAddin.Tests;

/// <summary>
/// Replays the MEP part of a recorded export through the pure export tail: the
/// folder is read back into exporter rows (ids → "dir/id" UniqueIds; a ref whose
/// id several levels hold is pinned to the candidate the run's end sits on, as
/// Revit's connector graph had it) and written twice, as exported
/// (<c>baseline/</c>) and with <see cref="MepTopology"/> (<c>normalized/</c>).
/// Opt-in: BIMDOWN_REPLAY_DIR = the export folder, BIMDOWN_REPLAY_OUT = output folder.
/// </summary>
public class ReplayTests(ITestOutputHelper output)
{
    static readonly string[] Curves = ["duct", "pipe", "cable_tray", "conduit"];
    static readonly string[] Hosts = ["equipment", "terminal", "mep_node"];
    static readonly string[] CurvePrefixes = ["du-", "pi-", "ct-", "co-"];

    [Fact]
    public void Replays_a_recorded_export()
    {
        var src = Environment.GetEnvironmentVariable("BIMDOWN_REPLAY_DIR");
        var dst = Environment.GetEnvironmentVariable("BIMDOWN_REPLAY_OUT");
        if (string.IsNullOrEmpty(src) || string.IsNullOrEmpty(dst)) { output.WriteLine("BIMDOWN_REPLAY_DIR / _OUT not set."); return; }
        foreach (var (name, normalize) in new[] { ("baseline", false), ("normalized", true) })
        {
            var dir = Path.Combine(dst, name);
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
            var tables = Read(src);
            ProjectWriter.WriteProject(dir, tables, new ShortIdGenerator(), Path.GetFileName(src), "replay", normalize);
            output.WriteLine($"{name}: {dir}");
        }
    }

    record El(string Dir, string Table, Dictionary<string, string?> Row, double[] A, double[]? B);

    static List<ExportedTable> Read(string src)
    {
        var (levelCols, levels) = CsvReader.Read(Path.Combine(src, "global", "level.csv"));
        var elev = levels.ToDictionary(r => r["id"]!, r => double.Parse(r["elevation"]!, System.Globalization.CultureInfo.InvariantCulture));
        var tables = new List<ExportedTable> { new("level", true, levelCols, levels) };
        var sysPath = Path.Combine(src, "global", "mep_system.csv");
        if (File.Exists(sysPath)) { var (c, r) = CsvReader.Read(sysPath); tables.Add(new("mep_system", true, c, r)); }

        var dirs = Directory.GetDirectories(src).Select(Path.GetFileName).Where(d => d == "global" || d!.StartsWith("lv-")).ToList();
        var els = new List<El>();
        var cols = new Dictionary<string, IReadOnlyList<string>>();
        var ports = new List<(string Dir, Dictionary<string, string?> Row)>();
        foreach (var d in dirs)
        {
            foreach (var t in Curves.Concat(Hosts))
            {
                var csv = Path.Combine(src, d!, $"{t}.csv");
                if (!File.Exists(csv)) continue;
                var (c, rows) = CsvReader.Read(csv);
                cols[t] = cols.TryGetValue(t, out var prev) ? prev.Union(c).ToList() : c;
                var geo = Geo(Path.Combine(src, d!, $"{t}.geojson"));
                foreach (var r in rows)
                {
                    if (!geo.TryGetValue(r["id"]!, out var g)) continue;
                    els.Add(new El(d!, t, r, g.Coords[0], g.Coords.Count > 1 ? g.Coords[1] : null));
                    if (g.Rotation is { } rot) r["rotation"] = rot.ToString(System.Globalization.CultureInfo.InvariantCulture);
                }
            }
            var conn = Path.Combine(src, d!, "connector.csv");
            if (File.Exists(conn)) { var (c, rows) = CsvReader.Read(conn); cols["connector"] = c; ports.AddRange(rows.Select(r => (d!, r))); }
        }

        string Uid(string dir, string id) => $"{dir}/{id}";
        double Elev(string dir) => elev.GetValueOrDefault(dir);
        var hostsById = els.Where(e => e.B is null).GroupBy(e => e.Row["id"]!).ToDictionary(g => g.Key, g => g.ToList());
        var curvesById = els.Where(e => e.B is not null).GroupBy(e => e.Row["id"]!).ToDictionary(g => g.Key, g => g.ToList());
        var portsOf = ports.GroupBy(p => Uid(p.Dir, p.Row["host_id"]!)).ToDictionary(g => g.Key, g => g.Select(p => p.Row).ToList());

        double[] PortPos(El h, Dictionary<string, string?> p)
        {
            double N(string k) => double.Parse(p[k] ?? "0", System.Globalization.CultureInfo.InvariantCulture);
            var th = double.Parse(h.Row.GetValueOrDefault("rotation") ?? "0", System.Globalization.CultureInfo.InvariantCulture) * Math.PI / 180;
            return [h.A[0] + N("offset_x") * Math.Cos(th) - N("offset_y") * Math.Sin(th), h.A[1] + N("offset_x") * Math.Sin(th) + N("offset_y") * Math.Cos(th), h.A[2] + N("offset_z")];
        }
        static double Dist(double[] a, double[] b) => Math.Sqrt(a.Zip(b, (x, y) => (x - y) * (x - y)).Sum());
        static double SegDist(double[] a, double[] b, double[] p)
        {
            var ab = a.Zip(b, (x, y) => y - x).ToArray();
            var l2 = ab.Sum(v => v * v);
            var t = l2 < 1e-12 ? 0 : Math.Clamp(p.Zip(a, (x, y) => x - y).Zip(ab, (x, y) => x * y).Sum() / l2, 0, 1);
            return Dist(p, a.Zip(ab, (x, y) => x + t * y).ToArray());
        }

        // Pin each ref to the element the run's end touches: own dir first unless another sits clearly closer.
        string? Pin(El c, string? reference)
        {
            if (string.IsNullOrEmpty(reference)) return reference;
            var i = reference.IndexOf(':');
            var (id, port) = i < 0 ? (reference, (string?)null) : (reference[..i], reference[(i + 1)..]);
            double EndDist(double[] p) => Math.Min(Dist(p, c.A), Dist(p, c.B!));
            if (CurvePrefixes.Any(id.StartsWith) && curvesById.TryGetValue(id, out var cands))
                return Uid(cands.OrderBy(o => Math.Min(SegDist(o.A, o.B!, c.A), SegDist(o.A, o.B!, c.B!)) + (o.Dir == c.Dir ? 0 : 0.5)).First().Dir, id);
            if (!hostsById.TryGetValue(id, out var hosts)) return null;
            var best = hosts.OrderBy(h =>
            {
                var hp = portsOf.GetValueOrDefault(Uid(h.Dir, id));
                var pr = port is null ? null : hp?.FirstOrDefault(p => p["name"] == port);
                var d = pr is not null ? EndDist(PortPos(h, pr)) : hp is { Count: > 0 } && port is not null ? hp.Min(p => EndDist(PortPos(h, p))) : EndDist(h.A);
                return d + (port is not null && pr is null ? 100 : 0) + (h.Dir == c.Dir ? 0 : 0.5);
            }).First();
            return port is null ? Uid(best.Dir, id) : $"{Uid(best.Dir, id)}:{port}";
        }

        string N3(double v) => Mapping.Names.Num(v);
        foreach (var t in Curves.Concat(Hosts))
        {
            var rows = new List<Dictionary<string, string?>>();
            foreach (var e in els.Where(e => e.Table == t))
            {
                var r = new Dictionary<string, string?>(e.Row) { ["id"] = Uid(e.Dir, e.Row["id"]!), ["level_id"] = e.Dir == "global" ? null : e.Dir };
                if (e.B is not null)
                {
                    r["start_x"] = N3(e.A[0]); r["start_y"] = N3(e.A[1]); r["start_z"] = N3(e.A[2]);
                    r["end_x"] = N3(e.B[0]); r["end_y"] = N3(e.B[1]); r["end_z"] = N3(e.B[2]);
                    r["_svg_d"] = $"M {N3(e.A[0])},{N3(e.A[1])} L {N3(e.B[0])},{N3(e.B[1])}";
                    r["from"] = Pin(e, e.Row.GetValueOrDefault("from"));
                    r["to"] = Pin(e, e.Row.GetValueOrDefault("to"));
                }
                else
                {
                    r["x"] = N3(e.A[0]); r["y"] = N3(e.A[1]); r["base_offset"] = N3(e.A[2] - Elev(e.Dir));
                }
                rows.Add(r);
            }
            if (rows.Count > 0) tables.Add(new ExportedTable(t, false, cols[t], rows));
        }
        if (ports.Count > 0)
            tables.Add(new ExportedTable("connector", false, cols["connector"], ports.Select(p => new Dictionary<string, string?>(p.Row)
            {
                ["id"] = Uid(p.Dir, p.Row["id"]!), ["host_id"] = Uid(p.Dir, p.Row["host_id"]!), ["level_id"] = p.Dir == "global" ? null : p.Dir,
            }).ToList()));
        return tables;
    }

    static Dictionary<string, (List<double[]> Coords, double? Rotation)> Geo(string path)
    {
        var map = new Dictionary<string, (List<double[]>, double?)>();
        if (!File.Exists(path)) return map;
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        foreach (var f in doc.RootElement.GetProperty("features").EnumerateArray())
        {
            var id = f.GetProperty("properties").GetProperty("id").GetString()!;
            var g = f.GetProperty("geometry");
            var c = g.GetProperty("coordinates");
            double[] P(JsonElement e) { var a = e.EnumerateArray().Select(x => x.GetDouble()).ToList(); while (a.Count < 3) a.Add(0); return [.. a]; }
            var pts = g.GetProperty("type").GetString() == "Point" ? [P(c)] : c.EnumerateArray().Select(P).ToList();
            double? rot = f.GetProperty("properties").TryGetProperty("rotation", out var r) ? r.GetDouble() : null;
            map[id] = (pts, rot);
        }
        return map;
    }
}
