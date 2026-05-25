using Autodesk.Revit.DB;

namespace BimDown.RevitAddin.Tables;

public class LevelTableExporter : ITableExporter
{
    public string TableName => "level";
    public bool IsGlobal => true;
    public IReadOnlyList<string> Columns { get; } = ["id", "number", "name", "elevation"];
    public IReadOnlyList<string> CsvColumns => Columns;

    public List<Dictionary<string, string?>> Export(Document doc)
    {
        var levels = new FilteredElementCollector(doc)
            .OfCategory(BuiltInCategory.OST_Levels)
            .WhereElementIsNotElementType()
            .OfType<Level>()
            .ToList();

        // number is required. Prefer the level's Mark; otherwise assign a 1-based
        // floor number ordered by elevation (lowest = 1).
        var rankByElevation = levels
            .OrderBy(l => l.Elevation)
            .Select((l, i) => (l.Id, Rank: i + 1))
            .ToDictionary(x => x.Id, x => x.Rank);

        var rows = new List<Dictionary<string, string?>>();
        foreach (var level in levels.OrderBy(e => e.Id.Value))
        {
            var mark = level.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.AsString();
            var number = string.IsNullOrWhiteSpace(mark)
                ? rankByElevation[level.Id].ToString()
                : mark;
            rows.Add(new Dictionary<string, string?>
            {
                ["id"] = level.UniqueId,
                ["number"] = number,
                ["name"] = level.Name,
                ["elevation"] = UnitConverter.FormatDouble(UnitConverter.Length(level.Elevation)),
            });
        }
        return rows;
    }
}

public class GridTableExporter : ITableExporter
{
    public string TableName => "grid";
    public bool IsGlobal => true;
    public IReadOnlyList<string> Columns { get; } = ["id", "number", "start_x", "start_y", "end_x", "end_y"];
    public IReadOnlyList<string> CsvColumns => Columns;

    public List<Dictionary<string, string?>> Export(Document doc)
    {
        var rows = new List<Dictionary<string, string?>>();
        var collector = new FilteredElementCollector(doc)
            .OfCategory(BuiltInCategory.OST_Grids)
            .WhereElementIsNotElementType();

        foreach (var element in collector.OrderBy(e => e.Id.Value))
        {
            if (element is not Grid grid) continue;
            var curve = grid.Curve;
            var start = curve.GetEndPoint(0);
            var end = curve.GetEndPoint(1);
            rows.Add(new Dictionary<string, string?>
            {
                ["id"] = grid.UniqueId,
                ["number"] = grid.Name,
                ["start_x"] = UnitConverter.FormatDouble(UnitConverter.Length(start.X)),
                ["start_y"] = UnitConverter.FormatDouble(UnitConverter.Length(start.Y)),
                ["end_x"] = UnitConverter.FormatDouble(UnitConverter.Length(end.X)),
                ["end_y"] = UnitConverter.FormatDouble(UnitConverter.Length(end.Y)),
            });
        }
        return rows;
    }
}
