using Autodesk.Revit.DB;

namespace BimDown.RevitAddin.Extractors;

public interface IFieldExtractor
{
    IReadOnlyList<string> FieldNames { get; }

    /// <summary>Fields derived by the CLI (not written to CSV).</summary>
    IReadOnlyList<string> ComputedFieldNames => [];

    /// <summary>
    /// Fields stored in the paired GeoJSON Feature properties (schema
    /// <c>storage: geojson_property</c>) rather than CSV. They remain in the
    /// extracted row dictionary so GeoJsonWriter can read them, but are excluded
    /// from <see cref="CompositeExtractor.CsvColumns"/>.
    /// </summary>
    IReadOnlyList<string> GeoJsonPropertyFieldNames => [];

    Dictionary<string, string?> Extract(Element element);
}
