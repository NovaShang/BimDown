using BimDown.RevitAddin.Mapping;

namespace BimDown.RevitAddin;

/// <summary>
/// Reshapes the Revit MEP connection graph into one BimDown can express, without
/// any format extension: runs connect only to hosts (fittings, devices), and a ref
/// resolves on the run's own level, then global/, then (the riser rule) on another
/// level when no level-local or global host takes the id.
/// <list type="bullet">
/// <item>Ports a run names that its host does not have (Revit connector order vs
/// index names): the host's port the run actually ends on.</item>
/// <item>Hosts Revit left without a level: the level below their insertion point.</item>
/// <item>Run ↔ run (a flex duct straight onto a duct end): a passive node between
/// them. A run end on another run's side (Revit taps): the main is split there and
/// a <c>fitting=tap</c> node joins the pieces and the branch.</item>
/// <item>Fittings whose runs all lie on another level move to that level.</item>
/// <item>A run that crosses the floor of the level its host is on is split at that
/// floor: a node on the upper level joins the pieces, the piece on the host's side
/// moves to the host's level, and the lower piece reaches the node with the riser
/// rule.</item>
/// </list>
/// Hosts still referenced from another directory are returned as cross-level
/// targets: <see cref="ShortIdGenerator"/> gives them ids no other directory uses,
/// so the riser rule finds exactly them.
/// Pure (no Revit API); runs on the exported rows before ids are assigned (ids are
/// Revit UniqueIds, levels are level UniqueIds).
/// </summary>
static class MepTopology
{
    static readonly HashSet<string> CurveTables = ["duct", "pipe", "cable_tray", "conduit"];
    static readonly HashSet<string> HostTables = ["equipment", "terminal", "mep_node"];

    /// <summary>UniqueId prefix of synthesized rows (no Revit element behind them).</summary>
    internal const string SynthPrefix = "bimdown-synth-"; // no ":" (port refs split on it)
    internal static bool IsSynthetic(string? uid) => uid is not null && uid.StartsWith(SynthPrefix, StringComparison.Ordinal);

    /// <summary>Distances in metres.</summary>
    const double Eps = 0.01;
    /// <summary>A named port the host lacks is replaced by the host's port the run ends within this of.</summary>
    const double PortSnap = 0.5;

    static readonly string[] NodeColumns = ["id", "number", "system_type", "kind", "fitting", "family", "type", "shape", "size_w", "size_h"];

    internal sealed class Result
    {
        /// <summary>Host UniqueIds referenced from runs in another directory.</summary>
        public HashSet<string> CrossLevelTargets { get; } = [];
        public int PortsRenamed, HostsLeveled, Couplings, Taps, NodesMoved, Risers;
    }

    record struct V(double X, double Y, double Z)
    {
        public static V operator +(V a, V b) => new(a.X + b.X, a.Y + b.Y, a.Z + b.Z);
        public static V operator -(V a, V b) => new(a.X - b.X, a.Y - b.Y, a.Z - b.Z);
        public static V operator *(V a, double k) => new(a.X * k, a.Y * k, a.Z * k);
        public double Dot(V b) => X * b.X + Y * b.Y + Z * b.Z;
        public double Len => Math.Sqrt(Dot(this));
    }

    static double D(V a, V b) => (a - b).Len;

    sealed class Ctx
    {
        public required List<ExportedTable> Tables;
        public required Dictionary<string, double> Elev;
        public required Dictionary<string, int> LevelIndex;
        public readonly Dictionary<string, (ExportedTable T, Dictionary<string, string?> Row)> Curves = new();
        public readonly Dictionary<string, (ExportedTable T, Dictionary<string, string?> Row)> Hosts = new();
        public readonly Dictionary<string, List<Dictionary<string, string?>>> Ports = new();
        public int Seq;

        public string Dir(Dictionary<string, string?> row) => ProjectWriter.GetPartitionDir(row, LevelIndex);
        public double ElevOf(string? levelId) => levelId is not null && Elev.TryGetValue(levelId, out var e) ? e : 0;
    }

    internal static Result Normalize(List<ExportedTable> tables)
    {
        var result = new Result();
        var elev = new Dictionary<string, double>();
        foreach (var r in tables.Where(t => t.TableName == "level").SelectMany(t => t.Rows))
            if (r.GetValueOrDefault("id") is { } id && Names.Parse(r.GetValueOrDefault("elevation")) is { } e) elev[id] = e;
        var ctx = new Ctx { Tables = tables, Elev = elev, LevelIndex = ProjectWriter.BuildLevelIndex(tables) };
        foreach (var t in tables)
        {
            var map = CurveTables.Contains(t.TableName) ? ctx.Curves : HostTables.Contains(t.TableName) ? ctx.Hosts : null;
            if (map is not null)
                foreach (var r in t.Rows)
                    if (r.GetValueOrDefault("id") is { } id) map.TryAdd(id, (t, r));
            if (t.TableName == "connector")
                foreach (var r in t.Rows)
                    if (r.GetValueOrDefault("host_id") is { } h)
                    {
                        if (!ctx.Ports.TryGetValue(h, out var list)) ctx.Ports[h] = list = [];
                        list.Add(r);
                    }
        }
        if (ctx.Curves.Count == 0) return result;

        LevelOrphanHosts(ctx, result);
        RenameMissingPorts(ctx, result);
        JoinRunToRun(ctx, result);
        MoveFittingsToTheirRuns(ctx, result);
        SplitRisersAndCollectTargets(ctx, result);
        return result;
    }

    // ─── Geometry ────────────────────────────────────────────

    static double Num(Dictionary<string, string?> row, string key) => Names.Parse(row.GetValueOrDefault(key)) ?? 0;

    static (V A, V B)? Ends(Dictionary<string, string?> row)
    {
        if (Names.Parse(row.GetValueOrDefault("start_x")) is not { } x0 || Names.Parse(row.GetValueOrDefault("start_y")) is not { } y0
            || Names.Parse(row.GetValueOrDefault("end_x")) is not { } x1 || Names.Parse(row.GetValueOrDefault("end_y")) is not { } y1)
            return null;
        return (new V(x0, y0, Num(row, "start_z")), new V(x1, y1, Num(row, "end_z")));
    }

    static bool IsArc(Dictionary<string, string?> row) => row.GetValueOrDefault("_svg_d")?.Contains(" A ") == true;

    static void SetEnds(Dictionary<string, string?> row, V a, V b)
    {
        row["start_x"] = Names.Num(a.X); row["start_y"] = Names.Num(a.Y); row["start_z"] = Names.Num(a.Z);
        row["end_x"] = Names.Num(b.X); row["end_y"] = Names.Num(b.Y); row["end_z"] = Names.Num(b.Z);
        row["length"] = Names.Num(D(a, b));
        row["_svg_d"] = $"M {Names.Num(a.X)},{Names.Num(a.Y)} L {Names.Num(b.X)},{Names.Num(b.Y)}";
    }

    /// <summary>World position of a host's insertion point.</summary>
    static V HostPos(Ctx ctx, Dictionary<string, string?> row)
    {
        var z = row.GetValueOrDefault("level_id") is { } lv && ctx.Elev.ContainsKey(lv)
            ? ctx.ElevOf(lv) + Num(row, "base_offset")
            : Names.Parse(row.GetValueOrDefault("_z")) ?? Num(row, "base_offset");
        return new V(Num(row, "x"), Num(row, "y"), z);
    }

    /// <summary>World position of a port (connector offsets are in the host's rotated frame).</summary>
    static V PortPos(Ctx ctx, Dictionary<string, string?> host, Dictionary<string, string?> port)
    {
        var h = HostPos(ctx, host);
        var th = Num(host, "rotation") * Math.PI / 180;
        double ox = Num(port, "offset_x"), oy = Num(port, "offset_y");
        return new V(h.X + ox * Math.Cos(th) - oy * Math.Sin(th), h.Y + ox * Math.Sin(th) + oy * Math.Cos(th), h.Z + Num(port, "offset_z"));
    }

    static (string Host, string? Port)? Split(string? reference)
    {
        if (string.IsNullOrEmpty(reference)) return null;
        var i = reference.IndexOf(':');
        return i < 0 ? (reference, null) : (reference[..i], reference[(i + 1)..]);
    }

    /// <summary>Point a ref is anchored at (port, host, or the referenced run's nearest point to <paramref name="near"/>).</summary>
    static V? Anchor(Ctx ctx, string? reference, V near)
    {
        if (Split(reference) is not { } r) return null;
        if (ctx.Hosts.TryGetValue(r.Host, out var h))
        {
            var port = r.Port is null ? null : ctx.Ports.GetValueOrDefault(r.Host)?.FirstOrDefault(p => p.GetValueOrDefault("name") == r.Port);
            return port is null ? HostPos(ctx, h.Row) : PortPos(ctx, h.Row, port);
        }
        if (ctx.Curves.TryGetValue(r.Host, out var c) && Ends(c.Row) is { } e) return Closest(e.A, e.B, near).P;
        return null;
    }

    static (V P, double T) Closest(V a, V b, V p)
    {
        var ab = b - a;
        var l2 = ab.Dot(ab);
        var t = l2 < 1e-12 ? 0 : Math.Clamp((p - a).Dot(ab) / l2, 0, 1);
        return (a + ab * t, t);
    }

    /// <summary>Whether `from` sits at the start point (else at the end), from where the refs anchor.</summary>
    static bool FromAtStart(Ctx ctx, Dictionary<string, string?> row, V a, V b)
    {
        double Cost(string? reference, V end) => Anchor(ctx, reference, end) is { } p ? D(p, end) : 0;
        string? from = row.GetValueOrDefault("from"), to = row.GetValueOrDefault("to");
        return Cost(from, a) + Cost(to, b) <= Cost(from, b) + Cost(to, a);
    }

    // ─── Rows ────────────────────────────────────────────────

    static ExportedTable NodeTableOf(Ctx ctx)
    {
        var t = ctx.Tables.FirstOrDefault(x => x.TableName == "mep_node");
        if (t is null) ctx.Tables.Add(t = new ExportedTable("mep_node", false, NodeColumns, []));
        return t;
    }

    static string NewNode(Ctx ctx, V at, string? levelId, Dictionary<string, string?> like, string? fitting)
    {
        var uid = $"{SynthPrefix}mn-{++ctx.Seq}";
        var row = new Dictionary<string, string?>
        {
            ["id"] = uid,
            ["level_id"] = levelId,
            ["x"] = Names.Num(at.X),
            ["y"] = Names.Num(at.Y),
            ["base_offset"] = Names.Num(at.Z - ctx.ElevOf(levelId)),
            ["system_type"] = like.GetValueOrDefault("system_type"),
            ["fitting"] = fitting,
        };
        var t = NodeTableOf(ctx);
        t.Rows.Add(row);
        ctx.Hosts[uid] = (t, row);
        return uid;
    }

    static Dictionary<string, string?> ClonePiece(Ctx ctx, (ExportedTable T, Dictionary<string, string?> Row) curve)
    {
        var row = new Dictionary<string, string?>(curve.Row)
        {
            ["id"] = $"{SynthPrefix}{curve.Row["id"]}#{++ctx.Seq}",
            ["number"] = null,
            ["mesh_file"] = null,
        };
        curve.T.Rows.Add(row);
        ctx.Curves[row["id"]!] = (curve.T, row);
        return row;
    }

    /// <summary>Level a point at height <paramref name="z"/> belongs to: the highest level at or below it.</summary>
    static string? LevelAt(Ctx ctx, double z)
    {
        var levels = ctx.LevelIndex.Keys.OrderBy(k => ctx.Elev[k]).ToList();
        if (levels.Count == 0) return null;
        return levels.LastOrDefault(k => ctx.Elev[k] <= z + Eps) ?? levels[0];
    }

    // ─── Steps ───────────────────────────────────────────────

    /// <summary>Hosts Revit gave no level (face-hosted terminals, roof caps): the level below them.</summary>
    static void LevelOrphanHosts(Ctx ctx, Result result)
    {
        foreach (var (_, (_, row)) in ctx.Hosts)
        {
            if (row.GetValueOrDefault("level_id") is { } lv && ctx.LevelIndex.ContainsKey(lv)) continue;
            if (Names.Parse(row.GetValueOrDefault("_z")) is not { } z || LevelAt(ctx, z) is not { } level) continue;
            row["level_id"] = level;
            row["top_level_id"] = null;
            row["base_offset"] = Names.Num(z - ctx.ElevOf(level));
            result.HostsLeveled++;
        }
    }

    /// <summary>
    /// A run naming a port its host lacks (Revit connector order differs from the
    /// connector table's index names): the host's port the run ends on.
    /// </summary>
    static void RenameMissingPorts(Ctx ctx, Result result)
    {
        foreach (var (_, (_, row)) in ctx.Curves)
        {
            if (Ends(row) is not { } e) continue;
            foreach (var side in new[] { "from", "to" })
            {
                if (Split(row.GetValueOrDefault(side)) is not { Port: { } port } r) continue;
                if (!ctx.Hosts.TryGetValue(r.Host, out var host) || !ctx.Ports.TryGetValue(r.Host, out var ports)) continue;
                if (ports.Any(p => p.GetValueOrDefault("name") == port)) continue;
                var other = row.GetValueOrDefault(side == "from" ? "to" : "from");
                var best = ports
                    .Where(p => p.GetValueOrDefault("name") is { } n && other != $"{r.Host}:{n}")
                    .Select(p => (Name: p["name"]!, Dist: Math.Min(D(PortPos(ctx, host.Row, p), e.A), D(PortPos(ctx, host.Row, p), e.B))))
                    .OrderBy(p => p.Dist).FirstOrDefault();
                if (best.Name is null || best.Dist > PortSnap) continue;
                row[side] = $"{r.Host}:{best.Name}";
                result.PortsRenamed++;
            }
        }
    }

    /// <summary>
    /// Runs referencing runs: end to end → a node between them; an end on the
    /// other run's side (a tap) → the main is split there with a tap node.
    /// </summary>
    static void JoinRunToRun(Ctx ctx, Result result)
    {
        var taps = new Dictionary<string, List<(double T, V At)>>();
        foreach (var (aId, a) in ctx.Curves.ToList())
        {
            foreach (var side in new[] { "from", "to" })
            {
                var bId = a.Row.GetValueOrDefault(side);
                if (bId is null || bId.Contains(':') || !ctx.Curves.TryGetValue(bId, out var b)) continue;
                if (Ends(a.Row) is not { } ea || Ends(b.Row) is not { } eb) continue;
                // A's end at B: the one nearer B's axis
                var pa = D(Closest(eb.A, eb.B, ea.A).P, ea.A) <= D(Closest(eb.A, eb.B, ea.B).P, ea.B) ? ea.A : ea.B;
                var (onB, t) = Closest(eb.A, eb.B, pa);
                var len = D(eb.A, eb.B);
                var backSide = b.Row.GetValueOrDefault("from") == aId ? "from" : b.Row.GetValueOrDefault("to") == aId ? "to" : null;
                var atEnd = len < Eps || t * len < 0.05 || (1 - t) * len < 0.05;
                if (backSide is not null || atEnd || IsArc(b.Row))
                {
                    // End to end: a node where they meet, on the upper of the two levels.
                    var pb = D(eb.A, pa) <= D(eb.B, pa) ? eb.A : eb.B;
                    var bEndSide = backSide;
                    if (bEndSide is null)
                    {
                        // B's ref at that end, when it isn't a host already.
                        var fromAtStart = FromAtStart(ctx, b.Row, eb.A, eb.B);
                        var s = (pb == eb.A) == fromAtStart ? "from" : "to";
                        if (Split(b.Row.GetValueOrDefault(s)) is { } existing && ctx.Hosts.TryGetValue(existing.Host, out var at))
                        {
                            // B already ends on a fitting there: A joins that fitting (a device port takes one run only).
                            a.Row[side] = existing.Port is null && at.T.TableName == "mep_node" ? existing.Host : null;
                            continue;
                        }
                        bEndSide = s;
                    }
                    var level = Upper(ctx, a.Row.GetValueOrDefault("level_id"), b.Row.GetValueOrDefault("level_id"));
                    var node = NewNode(ctx, (pa + pb) * 0.5, level, a.Row, null);
                    a.Row[side] = node;
                    b.Row[bEndSide] = node;
                    result.Couplings++;
                }
                else
                {
                    if (!taps.TryGetValue(bId, out var list)) taps[bId] = list = [];
                    list.Add((t, onB));
                }
            }
        }

        // Split each main at its taps; branches are pointed at the nearest tap node afterwards.
        var tapNodes = new Dictionary<string, List<(string Node, V At)>>();
        foreach (var (bId, list) in taps)
        {
            var b = ctx.Curves[bId];
            var (a0, b0) = Ends(b.Row)!.Value;
            var fromAtStart = FromAtStart(ctx, b.Row, a0, b0);
            string? startRef = b.Row.GetValueOrDefault(fromAtStart ? "from" : "to"), endRef = b.Row.GetValueOrDefault(fromAtStart ? "to" : "from");
            var len = D(a0, b0);
            var cuts = new List<(double T, V At, string Node)>();
            foreach (var (t, at) in list.OrderBy(x => x.T))
            {
                if (cuts.Count > 0 && (t - cuts[^1].T) * len < 0.05) continue; // same tap point (a cross)
                cuts.Add((t, at, NewNode(ctx, at, b.Row.GetValueOrDefault("level_id"), b.Row, "tap")));
                result.Taps++;
            }
            tapNodes[bId] = cuts.Select(c => (c.Node, c.At)).ToList();
            var points = new List<V> { a0 };
            points.AddRange(cuts.Select(c => c.At));
            points.Add(b0);
            for (var i = 0; i < points.Count - 1; i++)
            {
                var row = i == 0 ? b.Row : ClonePiece(ctx, b);
                SetEnds(row, points[i], points[i + 1]);
                var s = i == 0 ? startRef : cuts[i - 1].Node;
                var e = i == points.Count - 2 ? endRef : cuts[i].Node;
                row[fromAtStart ? "from" : "to"] = s;
                row[fromAtStart ? "to" : "from"] = e;
            }
        }

        foreach (var (_, (_, row)) in ctx.Curves)
        {
            foreach (var side in new[] { "from", "to" })
            {
                if (row.GetValueOrDefault(side) is not { } r || !tapNodes.TryGetValue(r, out var nodes) || Ends(row) is not { } e) continue;
                row[side] = nodes.OrderBy(n => Math.Min(D(n.At, e.A), D(n.At, e.B))).First().Node;
            }
        }
        // Refs to runs that were not exported (or anything left over) can't be expressed.
        foreach (var (_, (_, row)) in ctx.Curves)
            foreach (var side in new[] { "from", "to" })
                if (row.GetValueOrDefault(side) is { } r && !r.Contains(':') && ctx.Curves.ContainsKey(r)) row[side] = null;
    }

    static string? Upper(Ctx ctx, string? l1, string? l2)
    {
        if (l1 is null || !ctx.LevelIndex.ContainsKey(l1)) return l2;
        if (l2 is null || !ctx.LevelIndex.ContainsKey(l2)) return l1;
        return ctx.Elev[l2] > ctx.Elev[l1] ? l2 : l1;
    }

    /// <summary>
    /// Revit often gives a fitting another reference level than its runs (a tee on
    /// L3 at 2 m, its ducts on L1): a fitting whose runs all lie in one other level
    /// directory moves there (same height), unless it sits in its own storey and
    /// not in theirs.
    /// </summary>
    static void MoveFittingsToTheirRuns(Ctx ctx, Result result)
    {
        var dirsOf = new Dictionary<string, HashSet<string>>();
        foreach (var (_, (_, row)) in ctx.Curves)
            foreach (var side in new[] { "from", "to" })
                if (Split(row.GetValueOrDefault(side)) is { } r && ctx.Hosts.ContainsKey(r.Host))
                {
                    if (!dirsOf.TryGetValue(r.Host, out var set)) dirsOf[r.Host] = set = [];
                    set.Add(ctx.Dir(row));
                }
        foreach (var (id, set) in dirsOf)
        {
            var (t, row) = ctx.Hosts[id];
            if (t.TableName != "mep_node" || set.Count != 1) continue;
            var target = set.First();
            var dir = ctx.Dir(row);
            if (target == dir || target == "global" || dir == "global") continue;
            var z = HostPos(ctx, row).Z;
            // A fitting inside its own storey stays (a riser top on the floor above).
            if (InStorey(ctx, dir, z) && !InStorey(ctx, target, z)) continue;
            row["level_id"] = target;
            row["top_level_id"] = null;
            row["base_offset"] = Names.Num(z - ctx.ElevOf(target));
            result.NodesMoved++;
        }
    }

    /// <summary>Whether height <paramref name="z"/> lies between a level and the next one up.</summary>
    static bool InStorey(Ctx ctx, string level, double z)
    {
        var e = ctx.Elev[level];
        var above = ctx.Elev.Where(kv => ctx.LevelIndex.ContainsKey(kv.Key) && kv.Value > e + Eps).Select(kv => kv.Value).DefaultIfEmpty(double.MaxValue).Min();
        return z >= e - Eps && z < above + Eps;
    }

    /// <summary>
    /// Runs referencing a host in another directory. A run crossing the upper
    /// level's floor is split there (riser): the piece on the host's side moves to
    /// the host's level, a node on the upper level joins the pieces, and the lower
    /// piece references that node across levels. Every host still referenced from
    /// another directory becomes a cross-level target (project-unique id).
    /// </summary>
    static void SplitRisersAndCollectTargets(Ctx ctx, Result result)
    {
        foreach (var (cid, c) in ctx.Curves.ToList())
        {
            foreach (var side in new[] { "from", "to" })
            {
                var row = c.Row;
                if (Split(row.GetValueOrDefault(side)) is not { } r || !ctx.Hosts.TryGetValue(r.Host, out var host)) continue;
                string cDir = ctx.Dir(row), hDir = ctx.Dir(host.Row);
                if (cDir == hDir) continue;
                if (cDir == "global" || hDir == "global" || IsArc(row) || Ends(row) is not { } e
                    || !TrySplitRiser(ctx, c, side, r.Host, cDir, hDir, e, result))
                    result.CrossLevelTargets.Add(r.Host);
            }
        }
    }

    static bool TrySplitRiser(Ctx ctx, (ExportedTable T, Dictionary<string, string?> Row) c, string side, string hostId,
        string cDir, string hDir, (V A, V B) e, Result result)
    {
        var row = c.Row;
        var anchor = Anchor(ctx, row[side], e.A) ?? HostPos(ctx, ctx.Hosts[hostId].Row);
        var pIsA = D(anchor, e.A) <= D(anchor, e.B);
        V p = pIsA ? e.A : e.B, q = pIsA ? e.B : e.A;
        var hostUpper = ctx.Elev[hDir] > ctx.Elev[cDir];
        var floor = ctx.Elev[hostUpper ? hDir : cDir];
        var crosses = hostUpper ? p.Z > floor + Eps && q.Z < floor - Eps : p.Z < floor - Eps && q.Z > floor + Eps;
        if (!crosses) return false;

        var x = q + (p - q) * ((floor - q.Z) / (p.Z - q.Z));
        x = x with { Z = floor };
        var node = NewNode(ctx, x, hostUpper ? hDir : cDir, row, null);
        var piece = ClonePiece(ctx, c);
        piece["level_id"] = hDir;
        piece["top_level_id"] = null;
        var other = side == "from" ? "to" : "from";
        piece[other] = node;
        row[side] = node;
        // The original keeps the far end, the new piece the host's end (start → end order kept).
        if (pIsA) { SetEnds(row, x, q); SetEnds(piece, p, x); }
        else { SetEnds(row, q, x); SetEnds(piece, x, p); }
        // The lower piece reaches the upper level's node across levels.
        result.CrossLevelTargets.Add(node);
        result.Risers++;
        return true;
    }
}
