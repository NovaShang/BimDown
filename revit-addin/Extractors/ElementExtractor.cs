using Autodesk.Revit.DB;

namespace BimDown.RevitAddin.Extractors;

public class ElementExtractor : IFieldExtractor
{
    public IReadOnlyList<string> FieldNames { get; } =
    [
        "id", "number", "level_id", "created_at", "updated_at",
        "base_offset", "mesh_file", "volume",
        "bbox_min_x", "bbox_min_y", "bbox_min_z",
        "bbox_max_x", "bbox_max_y", "bbox_max_z"
    ];

    public IReadOnlyList<string> ComputedFieldNames { get; } =
    [
        "level_id", "created_at", "updated_at", "volume",
        "bbox_min_x", "bbox_min_y", "bbox_min_z",
        "bbox_max_x", "bbox_max_y", "bbox_max_z"
    ];

    // base_offset lives in the GeoJSON Feature properties (schema storage: geojson_property).
    public IReadOnlyList<string> GeoJsonPropertyFieldNames { get; } = ["base_offset"];

    public Dictionary<string, string?> Extract(Element element)
    {
        var fields = new Dictionary<string, string?>
        {
            ["id"] = element.UniqueId,
            ["number"] = element.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.AsString()
                      ?? element.get_Parameter(BuiltInParameter.ROOM_NUMBER)?.AsString()
                      ?? ParameterUtils.FindStringParameterByNames(element, "number", "编号"),
            ["level_id"] = GetLevelUniqueId(element),
            ["created_at"] = null,
            ["updated_at"] = null,
        };

        var baseOffset = element.get_Parameter(BuiltInParameter.INSTANCE_FREE_HOST_OFFSET_PARAM)?.AsDouble()
                      ?? element.get_Parameter(BuiltInParameter.FLOOR_HEIGHTABOVELEVEL_PARAM)?.AsDouble()
                      ?? element.get_Parameter(BuiltInParameter.WALL_BASE_OFFSET)?.AsDouble()
                      ?? element.get_Parameter(BuiltInParameter.STAIRS_BASE_OFFSET)?.AsDouble()
                      ?? element.get_Parameter(BuiltInParameter.INSTANCE_ELEVATION_PARAM)?.AsDouble();
        fields["base_offset"] = baseOffset is { } bo ? UnitConverter.FormatDouble(UnitConverter.Length(bo)) : null;

        var volume = element.get_Parameter(BuiltInParameter.HOST_VOLUME_COMPUTED)?.AsDouble();
        fields["volume"] = volume is { } v ? UnitConverter.FormatDouble(UnitConverter.Volume(v)) : null;

        GeometryUtils.WriteBoundingBox(fields, element);

        return fields;
    }

    static string? GetLevelUniqueId(Element element)
    {
        // Try LevelId property
        if (element.LevelId is { } levelId && levelId != ElementId.InvalidElementId)
        {
            return element.Document.GetElement(levelId)?.UniqueId;
        }

        // Try INSTANCE_SCHEDULE_ONLY_LEVEL_PARAM
        var levelParam = element.get_Parameter(BuiltInParameter.INSTANCE_SCHEDULE_ONLY_LEVEL_PARAM);
        if (levelParam?.AsElementId() is { } schedLevelId && schedLevelId != ElementId.InvalidElementId)
        {
            return element.Document.GetElement(schedLevelId)?.UniqueId;
        }

        // Try SCHEDULE_LEVEL_PARAM
        levelParam = element.get_Parameter(BuiltInParameter.SCHEDULE_LEVEL_PARAM);
        if (levelParam?.AsElementId() is { } scheduleLevelId && scheduleLevelId != ElementId.InvalidElementId)
        {
            return element.Document.GetElement(scheduleLevelId)?.UniqueId;
        }

        // Try STAIRS_BASE_LEVEL_PARAM
        levelParam = element.get_Parameter(BuiltInParameter.STAIRS_BASE_LEVEL_PARAM);
        if (levelParam?.AsElementId() is { } stairLevelId && stairLevelId != ElementId.InvalidElementId)
        {
            return element.Document.GetElement(stairLevelId)?.UniqueId;
        }

        return null;
    }
}
