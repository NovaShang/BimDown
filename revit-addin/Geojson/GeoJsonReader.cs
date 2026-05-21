using System.Globalization;
using System.IO;
using System.Text.Json;

namespace BimDown.RevitAddin.Geojson;

/// <summary>
/// Reads BimDown GeoJSON layer files back into the flat field dictionary the rest of the
/// addin's import pipeline consumes. Spatial 3D coordinates are split back into
/// <c>start_z</c>/<c>end_z</c> (lines) or returned via the <c>z</c> field (points).
/// </summary>
static class GeoJsonReader
{
    public static Dictionary<string, Dictionary<string, string?>> ReadAll(string inputDir)
    {
        var result = new Dictionary<string, Dictionary<string, string?>>();
        if (!Directory.Exists(inputDir)) return result;

        foreach (var levelDir in Directory.EnumerateDirectories(inputDir))
        {
            foreach (var file in Directory.EnumerateFiles(levelDir, "*.geojson"))
            {
                var fileName = Path.GetFileName(file);
                var mapping = GeoJsonTableMapping.All.FirstOrDefault(m =>
                    string.Equals(m.FileName, fileName, StringComparison.OrdinalIgnoreCase));
                if (mapping is null) continue;

                using var stream = File.OpenRead(file);
                using var doc = JsonDocument.Parse(stream);
                if (!doc.RootElement.TryGetProperty("features", out var features) ||
                    features.ValueKind != JsonValueKind.Array)
                    continue;

                foreach (var feat in features.EnumerateArray())
                {
                    if (!feat.TryGetProperty("properties", out var props)) continue;
                    if (!props.TryGetProperty("id", out var idEl) || idEl.ValueKind != JsonValueKind.String) continue;
                    var id = idEl.GetString();
                    if (id is null) continue;
                    if (!feat.TryGetProperty("geometry", out var geom)) continue;

                    var fields = mapping.Kind switch
                    {
                        GeoJsonGeomKind.Line    => ReadLine(geom, props, mapping.IsSpatial),
                        GeoJsonGeomKind.Point   => ReadPoint(geom, props, mapping.IsSpatial),
                        GeoJsonGeomKind.Polygon => ReadPolygon(geom, props),
                        GeoJsonGeomKind.Mixed   => ReadMixed(geom, props),
                        _ => null,
                    };
                    if (fields is null) continue;
                    result[id] = fields;
                }
            }
        }

        return result;
    }

    static Dictionary<string, string?>? ReadLine(JsonElement geom, JsonElement props, bool isSpatial)
    {
        if (!TryGetType(geom, out var t) || t != "LineString") return null;
        if (!geom.TryGetProperty("coordinates", out var coords) || coords.GetArrayLength() < 2) return null;
        var first = coords[0];
        var last = coords[coords.GetArrayLength() - 1];
        var x1 = first[0].GetDouble();
        var y1 = first[1].GetDouble();
        var x2 = last[0].GetDouble();
        var y2 = last[1].GetDouble();

        var fields = new Dictionary<string, string?>
        {
            ["start_x"] = Fmt(x1),
            ["start_y"] = Fmt(y1),
            ["end_x"] = Fmt(x2),
            ["end_y"] = Fmt(y2),
        };
        if (isSpatial)
        {
            var z1 = first.GetArrayLength() >= 3 ? first[2].GetDouble() : 0;
            var z2 = last.GetArrayLength() >= 3 ? last[2].GetDouble() : 0;
            fields["start_z"] = Fmt(z1);
            fields["end_z"] = Fmt(z2);
        }
        AttachLevelOffsets(fields, props);
        AttachArc(fields, props);
        return fields;
    }

    static Dictionary<string, string?>? ReadPoint(JsonElement geom, JsonElement props, bool isSpatial)
    {
        if (!TryGetType(geom, out var t) || t != "Point") return null;
        if (!geom.TryGetProperty("coordinates", out var coords) || coords.GetArrayLength() < 2) return null;
        var x = coords[0].GetDouble();
        var y = coords[1].GetDouble();

        var fields = new Dictionary<string, string?>
        {
            ["x"] = Fmt(x),
            ["y"] = Fmt(y),
        };
        if (isSpatial && coords.GetArrayLength() >= 3)
        {
            // Z is absolute; downstream pipeline will reconcile against level elevation.
            fields["z"] = Fmt(coords[2].GetDouble());
        }
        else
        {
            AttachLevelOffsets(fields, props);
        }
        if (props.TryGetProperty("rotation", out var rot) && rot.ValueKind == JsonValueKind.Number)
            fields["rotation"] = Fmt(rot.GetDouble());
        return fields;
    }

    static Dictionary<string, string?>? ReadPolygon(JsonElement geom, JsonElement props)
    {
        if (!TryGetType(geom, out var t) || t != "Polygon") return null;
        if (!geom.TryGetProperty("coordinates", out var coords) || coords.GetArrayLength() == 0) return null;
        var ring = coords[0];
        var n = ring.GetArrayLength();
        if (n < 3) return null;
        // Drop closing duplicate vertex if present
        var first = ring[0];
        var last = ring[n - 1];
        var end = (Math.Abs(first[0].GetDouble() - last[0].GetDouble()) < 1e-9 &&
                   Math.Abs(first[1].GetDouble() - last[1].GetDouble()) < 1e-9) ? n - 1 : n;

        var arr = new double[end][];
        for (var i = 0; i < end; i++)
        {
            arr[i] = [ring[i][0].GetDouble(), ring[i][1].GetDouble()];
        }
        var pointsJson = JsonSerializer.Serialize(arr);
        var fields = new Dictionary<string, string?> { ["points"] = pointsJson };
        AttachLevelOffsets(fields, props);
        return fields;
    }

    static Dictionary<string, string?>? ReadMixed(JsonElement geom, JsonElement props)
    {
        if (!TryGetType(geom, out var t)) return null;
        return t switch
        {
            "Point" => ReadPoint(geom, props, isSpatial: false),
            "LineString" => ReadLine(geom, props, isSpatial: false),
            "Polygon" => ReadPolygon(geom, props),
            _ => null,
        };
    }

    static void AttachLevelOffsets(Dictionary<string, string?> fields, JsonElement props)
    {
        if (props.TryGetProperty("base_offset", out var bo) && bo.ValueKind == JsonValueKind.Number)
            fields["base_offset"] = Fmt(bo.GetDouble());
        if (props.TryGetProperty("top_offset", out var to) && to.ValueKind == JsonValueKind.Number)
            fields["top_offset"] = Fmt(to.GetDouble());
        if (props.TryGetProperty("height_offset", out var ho) && ho.ValueKind == JsonValueKind.Number)
            fields["height_offset"] = Fmt(ho.GetDouble());
    }

    static void AttachArc(Dictionary<string, string?> fields, JsonElement props)
    {
        if (!props.TryGetProperty("arc", out var arc) || arc.ValueKind != JsonValueKind.Object) return;
        double radius = 0;
        bool largeArc = false, sweep = false;
        if (arc.TryGetProperty("radius", out var r) && r.ValueKind == JsonValueKind.Number) radius = r.GetDouble();
        if (arc.TryGetProperty("large_arc", out var la)) largeArc = la.ValueKind == JsonValueKind.True;
        if (arc.TryGetProperty("sweep", out var sw)) sweep = sw.ValueKind == JsonValueKind.True;
        // Round-trip via a synthetic SVG path string so existing downstream code keeps working.
        var x1 = fields.GetValueOrDefault("start_x") ?? "0";
        var y1 = fields.GetValueOrDefault("start_y") ?? "0";
        var x2 = fields.GetValueOrDefault("end_x") ?? "0";
        var y2 = fields.GetValueOrDefault("end_y") ?? "0";
        fields["_svg_d"] = $"M {x1},{y1} A {Fmt(radius)},{Fmt(radius)} 0 {(largeArc ? 1 : 0)},{(sweep ? 1 : 0)} {x2},{y2}";
    }

    static bool TryGetType(JsonElement geom, out string type)
    {
        type = "";
        if (!geom.TryGetProperty("type", out var t) || t.ValueKind != JsonValueKind.String) return false;
        type = t.GetString() ?? "";
        return !string.IsNullOrEmpty(type);
    }

    static string Fmt(double v) => UnitConverter.FormatDouble(v);
}
