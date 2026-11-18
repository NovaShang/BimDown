using Autodesk.Revit.DB;

namespace BimDown.RevitAddin.Import;

abstract class TableImporterBase(string tableName, int order, BuiltInCategory[] categories, Func<Element, bool>? filter = null)
    : ITableImporter
{
    public string TableName => tableName;
    public int Order => order;

    protected IdMap IdMap { get; private set; } = new();

    public void SetIdMap(IdMap idMap) => IdMap = idMap;

    /// <summary>True for importers that open their own transactions (stairs need a StairsEditScope).</summary>
    public virtual bool OwnsTransactions => false;

    public virtual ImportResult Import(Document doc, List<Dictionary<string, string?>> csvRows, IReadOnlyDictionary<string, string>? uuidToIdMap = null)
    {
        // Collect model elements for this category
        var modelElements = new List<Element>();
        foreach (var category in categories)
        {
            var collector = new FilteredElementCollector(doc)
                .OfCategory(category)
                .WhereElementIsNotElementType();

            foreach (var element in collector)
            {
                if (filter is not null && !filter(element)) continue;
                modelElements.Add(element);
            }
        }

        var diff = DiffEngine.Diff(csvRows, modelElements, uuidToIdMap);
        var errors = new List<string>();
        var created = 0;
        var updated = 0;
        var deleted = 0;

        // Delete
        foreach (var element in diff.ToDelete)
        {
            try
            {
                doc.Delete(element.Id);
                deleted++;
            }
            catch (Exception ex)
            {
                errors.Add($"Delete {element.UniqueId}: {ex.Message}");
            }
        }

        // Create
        foreach (var row in diff.ToCreate)
        {
            IdMap.CurrentDir = row.GetValueOrDefault("_dir") ?? "global";
            try
            {
                var newElement = CreateElement(doc, row);
                if (newElement is not null)
                {
                    var csvId = row.GetValueOrDefault("id");
                    if (csvId is not null)
                    {
                        BimDownParameter.Set(newElement, csvId);
                        IdMap.Register(csvId, newElement.Id);
                    }
                    created++;
                }
            }
            catch (Exception ex)
            {
                var id = row.GetValueOrDefault("id") ?? "?";
                errors.Add($"Create {id}: {ex.Message}");
            }
        }

        // Update
        foreach (var (row, element) in diff.ToUpdate)
        {
            IdMap.CurrentDir = row.GetValueOrDefault("_dir") ?? "global";
            try
            {
                UpdateElement(doc, row, element);
                var csvId = row.GetValueOrDefault("id");
                if (csvId is not null && element.IsValidObject)
                {
                    BimDownParameter.Set(element, csvId);
                    IdMap.Register(csvId, element.Id);
                }
                updated++;
            }
            catch (Exception ex)
            {
                var id = row.GetValueOrDefault("id") ?? element.UniqueId;
                errors.Add($"Update {id}: {ex.Message}");
            }
        }

        return new ImportResult(created, updated, deleted, errors);
    }

    /// <summary>Remembers a wall's top_attach_id; ImportCommand attaches once roofs / slabs exist.</summary>
    protected void QueueTopAttachment(Wall wall, Dictionary<string, string?> row)
    {
        if (row.GetValueOrDefault("top_attach_id") is { } target)
            ImportContext.PendingAttachments.Add((wall.Id, IdMap.CurrentDir, target));
    }

    /// <summary>Registers an element created outside CreateElement (e.g. a re-created floor).</summary>
    protected void Track(Dictionary<string, string?> row, Element element)
    {
        var csvId = row.GetValueOrDefault("id");
        if (csvId is null) return;
        BimDownParameter.Set(element, csvId);
        IdMap.Register(csvId, element.Id);
    }

    /// <summary>
    /// Levels above <paramref name="baseLevel"/>, lowest first. "The level immediately above"
    /// counts BimDown levels only (when the model has any), so a template's leftover
    /// "Level 2" does not cap walls that belong under the project's next level.
    /// </summary>
    internal static List<Level> LevelsAbove(Document doc, Level baseLevel)
    {
        var above = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>()
            .Where(l => l.Elevation > baseLevel.Elevation + 1e-6).OrderBy(l => l.Elevation).ToList();
        var ours = above.Where(l => BimDownParameter.Get(l) is not null).ToList();
        return ours.Count > 0 ? ours : above;
    }

    /// <summary>
    /// A wall's vertical span: base offset; top constraint from top_level_id (empty = the
    /// level immediately above, unless only an unconnected height is given); top offset on
    /// a constrained top (read-only on an unconnected one), else the unconnected height.
    /// </summary>
    protected void ApplyWallSpan(Document doc, Wall wall, Dictionary<string, string?> row)
    {
        double? Feet(string key) => UnitConverter.ParseNullableDouble(row.GetValueOrDefault(key)) is { } m ? UnitConverter.LengthToFeet(m) : null;
        if (Feet("base_offset") is { } baseOffset) wall.get_Parameter(BuiltInParameter.WALL_BASE_OFFSET)?.Set(baseOffset);
        var topOffset = Feet("top_offset");
        var height = Feet("height");
        var top = IdMap.Resolve(doc, row.GetValueOrDefault("top_level_id"));
        if (top is null && (height is null || topOffset is not null) && doc.GetElement(wall.LevelId) is Level baseLevel)
            top = LevelsAbove(doc, baseLevel).FirstOrDefault()?.Id;
        var heightType = wall.get_Parameter(BuiltInParameter.WALL_HEIGHT_TYPE);
        if (top is not null)
        {
            if (heightType?.AsElementId() != top) heightType?.Set(top);
            if (topOffset is { } to && wall.get_Parameter(BuiltInParameter.WALL_TOP_OFFSET) is { IsReadOnly: false } p) p.Set(to);
        }
        else if (height is { } h)
        {
            if (heightType is not null && heightType.AsElementId() != ElementId.InvalidElementId) heightType.Set(ElementId.InvalidElementId);
            if (wall.get_Parameter(BuiltInParameter.WALL_USER_HEIGHT_PARAM) is { IsReadOnly: false } p) p.Set(h);
        }
    }

    protected abstract Element? CreateElement(Document doc, Dictionary<string, string?> row);
    protected abstract void UpdateElement(Document doc, Dictionary<string, string?> row, Element element);

    internal static void SetMark(Element element, Dictionary<string, string?> row)
    {
        var number = row.GetValueOrDefault("number");
        if (number is not null)
            element.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.Set(number);
    }

    internal static Line ParseLine2D(Dictionary<string, string?> row)
    {
        var sx = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(row["start_x"]!));
        var sy = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(row["start_y"]!));
        var ex = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(row["end_x"]!));
        var ey = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(row["end_y"]!));
        return Line.CreateBound(new XYZ(sx, sy, 0), new XYZ(ex, ey, 0));
    }

    /// <summary>
    /// Parses a 2D curve from row data. Returns Arc if _svg_d contains arc, otherwise Line.
    /// </summary>
    internal static Curve ParseCurve2D(Dictionary<string, string?> row)
    {
        return GeometryUtils.CreateCurveFromRow(row) ?? ParseLine2D(row);
    }

    internal static Line Parse3DLine(Dictionary<string, string?> row)
    {
        var sx = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(row["start_x"]!));
        var sy = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(row["start_y"]!));
        var sz = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(row["start_z"]!));
        var ex = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(row["end_x"]!));
        var ey = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(row["end_y"]!));
        var ez = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(row["end_z"]!));
        return Line.CreateBound(new XYZ(sx, sy, sz), new XYZ(ex, ey, ez));
    }
}
