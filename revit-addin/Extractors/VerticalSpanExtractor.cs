using Autodesk.Revit.DB;

namespace BimDown.RevitAddin.Extractors;

public class VerticalSpanExtractor : IFieldExtractor
{
    public IReadOnlyList<string> FieldNames { get; } = ["base_level_id", "top_level_id", "top_offset", "height"];
    public IReadOnlyList<string> ComputedFieldNames { get; } = ["height"];

    // top_offset lives in the GeoJSON Feature properties (schema storage: geojson_property).
    public IReadOnlyList<string> GeoJsonPropertyFieldNames { get; } = ["top_offset"];

    public Dictionary<string, string?> Extract(Element element)
    {
        var fields = new Dictionary<string, string?>();

        // Base level — explicit so multi-story elements in global/ still know their bottom
        if (element.LevelId is { } baseLevelId && baseLevelId != ElementId.InvalidElementId)
            fields["base_level_id"] = element.Document.GetElement(baseLevelId)?.UniqueId;

        // Top level
        var topLevelId = element.get_Parameter(BuiltInParameter.WALL_HEIGHT_TYPE)?.AsElementId()
                      ?? element.get_Parameter(BuiltInParameter.FAMILY_TOP_LEVEL_PARAM)?.AsElementId()
                      ?? element.get_Parameter(BuiltInParameter.STAIRS_TOP_LEVEL_PARAM)?.AsElementId();

        var isConstrained = topLevelId is not null && topLevelId != ElementId.InvalidElementId;

        if (isConstrained)
        {
            fields["top_level_id"] = element.Document.GetElement(topLevelId!)?.UniqueId;

            // Top offset
            var topOffset = element.get_Parameter(BuiltInParameter.WALL_TOP_OFFSET)?.AsDouble()
                         ?? element.get_Parameter(BuiltInParameter.FAMILY_TOP_LEVEL_OFFSET_PARAM)?.AsDouble()
                         ?? element.get_Parameter(BuiltInParameter.STAIRS_TOP_OFFSET)?.AsDouble();
            fields["top_offset"] = topOffset is { } to ? UnitConverter.FormatDouble(UnitConverter.Length(to)) : null;
        }
        else
        {
            // Unconstrained: compute top elevation and find the nearest level
            var resolved = ResolveTopLevel(element);
            if (resolved is var (levelUniqueId, offset))
            {
                fields["top_level_id"] = levelUniqueId;
                fields["top_offset"] = UnitConverter.FormatDouble(UnitConverter.Length(offset));
            }
        }

        // Height
        var height = element.get_Parameter(BuiltInParameter.WALL_USER_HEIGHT_PARAM)?.AsDouble()
                  ?? element.get_Parameter(BuiltInParameter.FAMILY_HEIGHT_PARAM)?.AsDouble();
        fields["height"] = height is { } h ? UnitConverter.FormatDouble(UnitConverter.Length(h)) : null;

        return fields;
    }

    /// <summary>
    /// For unconstrained elements, computes top elevation from base level + base offset + height,
    /// then finds the nearest level and returns (levelUniqueId, offsetInFeet).
    /// </summary>
    static (string LevelUniqueId, double OffsetFeet)? ResolveTopLevel(Element element)
    {
        // Get base level elevation (feet)
        var baseLevelId = element.LevelId;
        if (baseLevelId is null || baseLevelId == ElementId.InvalidElementId)
            return null;
        if (element.Document.GetElement(baseLevelId) is not Level baseLevel)
            return null;

        var baseLevelElev = baseLevel.Elevation; // feet

        // Get base offset (feet)
        var baseOffset = element.get_Parameter(BuiltInParameter.WALL_BASE_OFFSET)?.AsDouble()
                      ?? element.get_Parameter(BuiltInParameter.INSTANCE_FREE_HOST_OFFSET_PARAM)?.AsDouble()
                      ?? 0.0;

        // Get unconnected height (feet)
        var height = element.get_Parameter(BuiltInParameter.WALL_USER_HEIGHT_PARAM)?.AsDouble()
                  ?? element.get_Parameter(BuiltInParameter.FAMILY_HEIGHT_PARAM)?.AsDouble();
        if (height is null)
            return null;

        var topElev = baseLevelElev + baseOffset + height.Value;

        // Find the nearest level
        var levels = new FilteredElementCollector(element.Document)
            .OfClass(typeof(Level))
            .Cast<Level>()
            .OrderBy(l => l.Elevation)
            .ToList();

        if (levels.Count == 0)
            return null;

        // Find the level closest to the top elevation
        Level? bestLevel = null;
        var bestDist = double.MaxValue;
        foreach (var level in levels)
        {
            var dist = Math.Abs(level.Elevation - topElev);
            if (dist < bestDist)
            {
                bestDist = dist;
                bestLevel = level;
            }
        }

        if (bestLevel is null)
            return null;

        var offset = topElev - bestLevel.Elevation;
        return (bestLevel.UniqueId, offset);
    }
}
