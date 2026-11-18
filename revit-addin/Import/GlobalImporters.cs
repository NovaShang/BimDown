using Autodesk.Revit.DB;

namespace BimDown.RevitAddin.Import;

class LevelImporter() : TableImporterBase("level", 0, [BuiltInCategory.OST_Levels])
{
    protected override Element? CreateElement(Document doc, Dictionary<string, string?> row)
    {
        var elevationStr = row.GetValueOrDefault("elevation")
            ?? throw new InvalidOperationException("elevation is required");
        var elevationFeet = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(elevationStr));
        var name = row.GetValueOrDefault("name");

        // A level without a BimDown id (e.g. the template's "Level 1" / "Level 2") with the
        // same name or elevation is adopted: creating another would clash on the name
        // ("Name must be unique") or leave a duplicate level with its own views.
        var adopted = Unclaimed(doc, name, elevationFeet);
        var level = adopted ?? Level.Create(doc, elevationFeet);
        if (Math.Abs(level.Elevation - elevationFeet) > 1e-9) level.Elevation = elevationFeet;
        if (name is not null && level.Name != name)
        {
            var oldName = level.Name;
            level.Name = name;
            // An adopted level's plan views keep the template's name ("Level 1"): follow the level.
            foreach (var view in new FilteredElementCollector(doc).OfClass(typeof(ViewPlan)).Cast<ViewPlan>()
                         .Where(v => !v.IsTemplate && v.GenLevel?.Id == level.Id && v.Name == oldName))
            {
                try { view.Name = name; } catch { /* name taken by another view of that type */ }
            }
        }
        SetMark(level, row);
        // A level made through the API has no views; Revit's Level tool adds a floor plan
        // (text notes and tags are placed in it).
        if (adopted is null && new FilteredElementCollector(doc).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>()
                .FirstOrDefault(t => t.ViewFamily == ViewFamily.FloorPlan) is { } planType)
            ViewPlan.Create(doc, planType.Id, level.Id);

        return level;
    }

    static Level? Unclaimed(Document doc, string? name, double elevationFeet)
    {
        var free = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>()
            .Where(l => BimDownParameter.Get(l) is null).ToList();
        return free.FirstOrDefault(l => name is not null && l.Name == name)
               ?? free.FirstOrDefault(l => Math.Abs(l.Elevation - elevationFeet) < UnitConverter.LengthToFeet(1e-3));
    }

    protected override void UpdateElement(Document doc, Dictionary<string, string?> row, Element element)
    {
        if (element is not Level level) return;

        var name = row.GetValueOrDefault("name");
        if (name is not null && level.Name != name) level.Name = name;

        var elevationStr = row.GetValueOrDefault("elevation");
        if (elevationStr is not null)
            level.Elevation = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(elevationStr));

        SetMark(level, row);
    }
}

class GridImporter() : TableImporterBase("grid", 1, [BuiltInCategory.OST_Grids])
{
    protected override Element? CreateElement(Document doc, Dictionary<string, string?> row)
    {
        var line = ParseLine2D(row);
        var grid = Grid.Create(doc, line);

        var number = row.GetValueOrDefault("number");
        if (number is not null) grid.Name = number;

        return grid;
    }

    protected override void UpdateElement(Document doc, Dictionary<string, string?> row, Element element)
    {
        if (element is not Grid grid) return;

        var number = row.GetValueOrDefault("number");
        if (number is not null && grid.Name != number) grid.Name = number;

        // Grid geometry updates are limited in Revit — log a warning if endpoints differ
    }
}
