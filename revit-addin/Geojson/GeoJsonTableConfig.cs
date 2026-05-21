namespace BimDown.RevitAddin.Geojson;

enum GeoJsonGeomKind { Line, Point, Polygon, Mixed }

/// <summary>
/// Mapping between BimDown table name and its on-disk GeoJSON layer.
/// <para><c>IsSpatial</c> means the element's geometry coordinates carry an absolute Z
/// (3D LineString / 3D Point). Level-anchored tables (wall, slab, column, …) use 2D
/// geometry with Z scalars stored in <c>properties.base_offset</c> / <c>top_offset</c>.</para>
/// </summary>
record GeoJsonTableMapping(string TableName, string FileName, GeoJsonGeomKind Kind, bool IsSpatial)
{
    public static IReadOnlyList<GeoJsonTableMapping> All { get; } =
    [
        // Architecture — level-anchored
        new("wall",            "wall.geojson",            GeoJsonGeomKind.Line,    IsSpatial: false),
        new("column",          "column.geojson",          GeoJsonGeomKind.Point,   IsSpatial: false),
        new("slab",            "slab.geojson",            GeoJsonGeomKind.Polygon, IsSpatial: false),
        new("roof",            "roof.geojson",            GeoJsonGeomKind.Polygon, IsSpatial: false),
        new("ceiling",         "ceiling.geojson",         GeoJsonGeomKind.Polygon, IsSpatial: false),
        new("room_separator",  "room_separator.geojson",  GeoJsonGeomKind.Line,    IsSpatial: false),
        new("curtain_wall",    "curtain_wall.geojson",    GeoJsonGeomKind.Line,    IsSpatial: false),
        new("opening",         "opening.geojson",         GeoJsonGeomKind.Mixed,   IsSpatial: false),
        // Architecture — spatial
        new("stair",           "stair.geojson",           GeoJsonGeomKind.Line,    IsSpatial: true),
        new("ramp",            "ramp.geojson",            GeoJsonGeomKind.Line,    IsSpatial: true),
        new("railing",         "railing.geojson",         GeoJsonGeomKind.Line,    IsSpatial: true),
        // Structure
        new("structure_wall",  "structure_wall.geojson",  GeoJsonGeomKind.Line,    IsSpatial: false),
        new("structure_column","structure_column.geojson",GeoJsonGeomKind.Point,   IsSpatial: false),
        new("structure_slab",  "structure_slab.geojson",  GeoJsonGeomKind.Polygon, IsSpatial: false),
        new("beam",            "beam.geojson",            GeoJsonGeomKind.Line,    IsSpatial: true),
        new("brace",           "brace.geojson",           GeoJsonGeomKind.Line,    IsSpatial: true),
        new("foundation",      "foundation.geojson",      GeoJsonGeomKind.Mixed,   IsSpatial: false),
        // MEP — spatial
        new("duct",            "duct.geojson",            GeoJsonGeomKind.Line,    IsSpatial: true),
        new("pipe",            "pipe.geojson",            GeoJsonGeomKind.Line,    IsSpatial: true),
        new("cable_tray",      "cable_tray.geojson",      GeoJsonGeomKind.Line,    IsSpatial: true),
        new("conduit",         "conduit.geojson",         GeoJsonGeomKind.Line,    IsSpatial: true),
        new("equipment",       "equipment.geojson",       GeoJsonGeomKind.Point,   IsSpatial: true),
        new("terminal",        "terminal.geojson",        GeoJsonGeomKind.Point,   IsSpatial: true),
        new("mep_node",        "mep_node.geojson",        GeoJsonGeomKind.Point,   IsSpatial: true),
    ];

    static readonly Dictionary<string, GeoJsonTableMapping> ByTable =
        All.ToDictionary(m => m.TableName);

    public static GeoJsonTableMapping? ForTable(string tableName) =>
        ByTable.GetValueOrDefault(tableName);
}
