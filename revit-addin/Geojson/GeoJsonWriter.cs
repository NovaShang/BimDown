using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace BimDown.RevitAddin.Geojson;

/// <summary>
/// Writes BimDown geometry layers as GeoJSON FeatureCollection files.
/// Field dictionaries are partitioned by <c>level_id</c> (the on-disk directory name).
/// </summary>
static class GeoJsonWriter
{
    public static void WriteAll(
        string outputDir,
        List<(string TableName, List<Dictionary<string, string?>> Rows)> tables,
        List<Dictionary<string, string?>> levelRows)
    {
        var levelElevation = BuildLevelElevationMap(levelRows);

        foreach (var (tableName, rows) in tables)
        {
            var mapping = GeoJsonTableMapping.ForTable(tableName);
            if (mapping is null) continue;

            var grouped = rows
                .Where(r => r.GetValueOrDefault("level_id") is not null)
                .GroupBy(r => r["level_id"]!);

            foreach (var group in grouped)
            {
                var levelDir = Path.Combine(outputDir, group.Key);
                var path = Path.Combine(levelDir, mapping.FileName);
                var baseElevation = levelElevation.TryGetValue(group.Key, out var e) ? e : 0;

                var features = new List<JsonObject>();
                foreach (var row in group)
                {
                    var feat = mapping.Kind switch
                    {
                        GeoJsonGeomKind.Line    => RenderLine(row, mapping.IsSpatial),
                        GeoJsonGeomKind.Point   => RenderPoint(row, mapping.IsSpatial, baseElevation),
                        GeoJsonGeomKind.Polygon => RenderPolygon(row),
                        GeoJsonGeomKind.Mixed   => RenderMixed(row, baseElevation),
                        _ => null
                    };
                    if (feat is not null) features.Add(feat);
                }

                if (features.Count == 0) continue;
                if (!Directory.Exists(levelDir)) Directory.CreateDirectory(levelDir);
                WriteFeatureCollection(path, features);
            }
        }
    }

    // ─── Per-geometry renderers ──────────────────────────────

    static JsonObject? RenderLine(Dictionary<string, string?> row, bool isSpatial)
    {
        var id = row.GetValueOrDefault("id");
        if (id is null) return null;

        var x1 = ParseOrNull(row.GetValueOrDefault("start_x"));
        var y1 = ParseOrNull(row.GetValueOrDefault("start_y"));
        var x2 = ParseOrNull(row.GetValueOrDefault("end_x"));
        var y2 = ParseOrNull(row.GetValueOrDefault("end_y"));
        if (x1 is null || y1 is null || x2 is null || y2 is null) return null;

        JsonArray a, b;
        if (isSpatial)
        {
            var z1 = ParseOr(row.GetValueOrDefault("start_z"), 0);
            var z2 = ParseOr(row.GetValueOrDefault("end_z"), 0);
            a = Coord(x1.Value, y1.Value, z1);
            b = Coord(x2.Value, y2.Value, z2);
        }
        else
        {
            a = Coord(x1.Value, y1.Value);
            b = Coord(x2.Value, y2.Value);
        }

        var props = StartProps(id);
        if (!isSpatial) AttachLevelOffset(props, row);
        AttachArc(props, row);

        return new JsonObject
        {
            ["type"] = "Feature",
            ["properties"] = props,
            ["geometry"] = new JsonObject
            {
                ["type"] = "LineString",
                ["coordinates"] = new JsonArray(a, b),
            },
        };
    }

    static JsonObject? RenderPoint(Dictionary<string, string?> row, bool isSpatial, double baseElevation)
    {
        var id = row.GetValueOrDefault("id");
        var x = ParseOrNull(row.GetValueOrDefault("x"));
        var y = ParseOrNull(row.GetValueOrDefault("y"));
        if (id is null || x is null || y is null) return null;

        JsonArray coords;
        var props = StartProps(id);
        if (isSpatial)
        {
            // Z = level.elevation + base_offset (consumed; not written to props)
            var baseOffset = ParseOr(row.GetValueOrDefault("base_offset"), 0);
            coords = Coord(x.Value, y.Value, baseElevation + baseOffset);
        }
        else
        {
            coords = Coord(x.Value, y.Value);
            AttachLevelOffset(props, row);
        }

        var rot = ParseOr(row.GetValueOrDefault("rotation"), 0);
        if (rot != 0) props["rotation"] = rot;

        AttachSize(props, row);

        return new JsonObject
        {
            ["type"] = "Feature",
            ["properties"] = props,
            ["geometry"] = new JsonObject
            {
                ["type"] = "Point",
                ["coordinates"] = coords,
            },
        };
    }

    static JsonObject? RenderPolygon(Dictionary<string, string?> row)
    {
        var id = row.GetValueOrDefault("id");
        var pointsJson = row.GetValueOrDefault("points");
        if (id is null || pointsJson is null) return null;

        double[][]? points;
        try { points = JsonSerializer.Deserialize<double[][]>(pointsJson); }
        catch { return null; }
        if (points is null || points.Length < 3) return null;

        var ring = new JsonArray();
        foreach (var p in points) ring.Add(Coord(p[0], p[1]));
        if (points.Length > 0)
        {
            var first = points[0];
            var last = points[^1];
            if (Math.Abs(first[0] - last[0]) > 1e-9 || Math.Abs(first[1] - last[1]) > 1e-9)
                ring.Add(Coord(first[0], first[1]));
        }

        var props = StartProps(id);
        AttachLevelOffset(props, row);

        return new JsonObject
        {
            ["type"] = "Feature",
            ["properties"] = props,
            ["geometry"] = new JsonObject
            {
                ["type"] = "Polygon",
                ["coordinates"] = new JsonArray(ring),
            },
        };
    }

    static JsonObject? RenderMixed(Dictionary<string, string?> row, double baseElevation)
    {
        if (row.GetValueOrDefault("points") is not null) return RenderPolygon(row);
        if (row.GetValueOrDefault("start_x") is not null) return RenderLine(row, isSpatial: false);
        if (row.GetValueOrDefault("x") is not null) return RenderPoint(row, isSpatial: false, baseElevation);
        return null;
    }

    // ─── Helpers ─────────────────────────────────────────────

    static JsonObject StartProps(string id) => new() { ["id"] = id };

    static JsonArray Coord(double x, double y) =>
        new(JsonValue.Create(Round(x)), JsonValue.Create(Round(y)));

    static JsonArray Coord(double x, double y, double z) =>
        new(JsonValue.Create(Round(x)), JsonValue.Create(Round(y)), JsonValue.Create(Round(z)));

    static double Round(double v)
    {
        if (double.IsNaN(v) || double.IsInfinity(v)) return 0;
        return Math.Round(v, 6, MidpointRounding.AwayFromZero);
    }

    static void AttachLevelOffset(JsonObject props, Dictionary<string, string?> row)
    {
        var baseOffset = ParseOrNull(row.GetValueOrDefault("base_offset"));
        if (baseOffset is { } bo && bo != 0) props["base_offset"] = bo;
        var topOffset = ParseOrNull(row.GetValueOrDefault("top_offset"));
        if (topOffset is { } to && to != 0) props["top_offset"] = to;
        var heightOffset = ParseOrNull(row.GetValueOrDefault("height_offset"));
        if (heightOffset is { } ho) props["height_offset"] = ho;
    }

    /// <summary>
    /// Optional `size: [x, y, z]` Feature property derived from the element's
    /// bbox (max − min). Only useful for Point features whose geometry alone
    /// carries no extent; line/polygon features already encode their size
    /// in the coordinates. Skipped if any bbox component is missing or the
    /// resulting volume is zero (no measurable geometry).
    /// </summary>
    static void AttachSize(JsonObject props, Dictionary<string, string?> row)
    {
        var minX = ParseOrNull(row.GetValueOrDefault("bbox_min_x"));
        var minY = ParseOrNull(row.GetValueOrDefault("bbox_min_y"));
        var minZ = ParseOrNull(row.GetValueOrDefault("bbox_min_z"));
        var maxX = ParseOrNull(row.GetValueOrDefault("bbox_max_x"));
        var maxY = ParseOrNull(row.GetValueOrDefault("bbox_max_y"));
        var maxZ = ParseOrNull(row.GetValueOrDefault("bbox_max_z"));
        if (minX is null || minY is null || minZ is null
            || maxX is null || maxY is null || maxZ is null) return;

        var sx = maxX.Value - minX.Value;
        var sy = maxY.Value - minY.Value;
        var sz = maxZ.Value - minZ.Value;
        if (sx <= 0 && sy <= 0 && sz <= 0) return;

        props["size"] = new JsonArray(
            JsonValue.Create(Round(sx)),
            JsonValue.Create(Round(sy)),
            JsonValue.Create(Round(sz)));
    }

    static void AttachArc(JsonObject props, Dictionary<string, string?> row)
    {
        var svgD = row.GetValueOrDefault("_svg_d");
        if (svgD is null) return;
        var arc = ParseArcD(svgD);
        if (arc is null) return;
        props["arc"] = new JsonObject
        {
            ["radius"] = Round(arc.Value.Radius),
            ["large_arc"] = arc.Value.LargeArc,
            ["sweep"] = arc.Value.Sweep,
        };
    }

    static (double Radius, bool LargeArc, bool Sweep)? ParseArcD(string d)
    {
        var match = System.Text.RegularExpressions.Regex.Match(
            d,
            @"A\s*(-?[\d.]+)[,\s]+(-?[\d.]+)\s+\d+\s+(\d)[,\s]+(\d)\s+(-?[\d.]+)[,\s]+(-?[\d.]+)");
        if (!match.Success) return null;
        var rx = double.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture);
        var ry = double.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture);
        var largeArc = match.Groups[3].Value == "1";
        var sweep = match.Groups[4].Value == "1";
        return ((rx + ry) / 2, largeArc, sweep);
    }

    static Dictionary<string, double> BuildLevelElevationMap(List<Dictionary<string, string?>> levelRows)
    {
        var map = new Dictionary<string, double>();
        foreach (var row in levelRows)
        {
            var id = row.GetValueOrDefault("id");
            var elevation = ParseOrNull(row.GetValueOrDefault("elevation"));
            if (id is not null && elevation is { } e) map[id] = e;
        }
        return map;
    }

    static double? ParseOrNull(string? s) =>
        s is not null && double.TryParse(s, NumberStyles.Any, CultureInfo.InvariantCulture, out var v) ? v : null;

    static double ParseOr(string? s, double fallback) => ParseOrNull(s) ?? fallback;

    static void WriteFeatureCollection(string path, List<JsonObject> features)
    {
        // Compact one-feature-per-line for clean diffs and AI readability.
        var sb = new StringBuilder(1024);
        sb.Append("{\n  \"type\": \"FeatureCollection\",\n  \"features\": [");
        for (var i = 0; i < features.Count; i++)
        {
            sb.Append(i == 0 ? "\n    " : ",\n    ");
            sb.Append(features[i].ToJsonString());
        }
        sb.Append("\n  ]\n}\n");
        File.WriteAllText(path, sb.ToString());
    }
}
