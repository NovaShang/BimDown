using Autodesk.Revit.DB;

namespace BimDown.RevitAddin.Extractors;

public class CompositeExtractor(
    IFieldExtractor[] extractors,
    string[]? inlineFieldNames = null,
    Func<Element, Dictionary<string, string?>>? inlineExtract = null,
    string[]? computedInlineFieldNames = null,
    string[]? geoJsonInlineFieldNames = null,
    Action<Element, Dictionary<string, string?>>? post = null,
    string[]? csvFieldNames = null)
{
    public IReadOnlyList<string> FieldNames { get; } = BuildFieldNames(extractors, inlineFieldNames);
    public IReadOnlyList<string> CsvColumns { get; } = BuildCsvColumns(extractors, inlineFieldNames,
        [.. computedInlineFieldNames ?? [], .. geoJsonInlineFieldNames ?? []], csvFieldNames);

    public Dictionary<string, string?> Extract(Element element)
    {
        var result = new Dictionary<string, string?>();
        foreach (var extractor in extractors)
        {
            foreach (var kv in extractor.Extract(element))
                result[kv.Key] = kv.Value;
        }
        if (inlineExtract is not null)
        {
            foreach (var kv in inlineExtract(element))
                result[kv.Key] = kv.Value;
        }
        // Row-level fix-ups that need the merged fields (reversed walls, boundaries, …)
        post?.Invoke(element, result);
        return result;
    }

    static List<string> BuildFieldNames(IFieldExtractor[] extractors, string[]? inlineFieldNames)
    {
        var names = new List<string>();
        var seen = new HashSet<string>();
        foreach (var ex in extractors)
        {
            foreach (var name in ex.FieldNames)
            {
                if (seen.Add(name))
                    names.Add(name);
            }
        }
        if (inlineFieldNames is not null)
        {
            foreach (var name in inlineFieldNames)
            {
                if (seen.Add(name))
                    names.Add(name);
            }
        }
        return names;
    }

    static List<string> BuildCsvColumns(IFieldExtractor[] extractors, string[]? inlineFieldNames, string[]? computedInlineFieldNames,
        string[]? csvFieldNames)
    {
        // Both computed (CLI-derived) and geojson_property (stored in the paired
        // GeoJSON Feature properties) fields are kept out of the CSV.
        var excluded = new HashSet<string>();
        foreach (var ex in extractors)
        {
            foreach (var name in ex.ComputedFieldNames)
                excluded.Add(name);
            foreach (var name in ex.GeoJsonPropertyFieldNames)
                excluded.Add(name);
        }
        if (computedInlineFieldNames is not null)
        {
            foreach (var name in computedInlineFieldNames)
                excluded.Add(name);
        }

        // Fields a table stores in CSV although a base extractor keeps them in GeoJSON
        // (hosted elements' sill base_offset).
        if (csvFieldNames is not null)
            foreach (var name in csvFieldNames)
                excluded.Remove(name);

        var allFields = BuildFieldNames(extractors, inlineFieldNames);
        return allFields.Where(f => !excluded.Contains(f)).ToList();
    }

    // Static helpers to expand base chains into flat extractor arrays

    public static IFieldExtractor[] ExpandLineElement() => [new ElementExtractor(), new LineElementExtractor()];
    public static IFieldExtractor[] ExpandSpatialLineElement() => [new ElementExtractor(), new LineElementExtractor(), new SpatialLineElementExtractor()];
    public static IFieldExtractor[] ExpandPointElement() => [new ElementExtractor(), new PointElementExtractor()];
    public static IFieldExtractor[] ExpandPolygonElement() => [new ElementExtractor(), new PolygonElementExtractor()];
    public static IFieldExtractor[] ExpandHostedElement() => [new ElementExtractor(), new HostedElementExtractor()];
}
