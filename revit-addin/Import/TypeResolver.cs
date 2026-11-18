using Autodesk.Revit.DB;

namespace BimDown.RevitAddin.Import;

static class TypeResolver
{
    public static WallType ResolveOrCreateWallType(Document doc, double thicknessMeters)
    {
        var thicknessMm = (int)Math.Round(thicknessMeters * 1000);
        var targetName = $"BimDown_{thicknessMm}mm";
        var thicknessFeet = UnitConverter.LengthToFeet(thicknessMeters);

        // Try to find existing type with matching name
        var existing = new FilteredElementCollector(doc)
            .OfClass(typeof(WallType))
            .Cast<WallType>()
            .FirstOrDefault(wt => wt.Name == targetName);
        if (existing is not null) return existing;

        // Try to find a basic wall type to duplicate
        var template = new FilteredElementCollector(doc)
            .OfClass(typeof(WallType))
            .Cast<WallType>()
            .FirstOrDefault(wt => wt.Kind == WallKind.Basic);

        if (template is null)
            throw new InvalidOperationException("No basic WallType found to duplicate");

        var newType = (WallType)template.Duplicate(targetName);

        // Set width on the compound structure
        var cs = newType.GetCompoundStructure();
        if (cs is not null)
        {
            var layers = cs.GetLayers();
            if (layers.Count > 0 && thicknessFeet > 0)
            {
                cs.SetLayerWidth(0, thicknessFeet);
                SetStructure(newType, cs);
            }
        }

        return newType;
    }

    public static FloorType ResolveOrCreateFloorType(Document doc, double thicknessMeters)
    {
        var thicknessMm = (int)Math.Round(thicknessMeters * 1000);
        var targetName = $"BimDown_{thicknessMm}mm";
        var thicknessFeet = UnitConverter.LengthToFeet(thicknessMeters);

        var existing = new FilteredElementCollector(doc)
            .OfClass(typeof(FloorType))
            .Cast<FloorType>()
            .FirstOrDefault(ft => ft.Name == targetName);
        if (existing is not null) return existing;

        var template = new FilteredElementCollector(doc)
            .OfClass(typeof(FloorType))
            .Cast<FloorType>()
            .FirstOrDefault();

        if (template is null)
            throw new InvalidOperationException("No FloorType found to duplicate");

        var newType = (FloorType)template.Duplicate(targetName);

        var cs = newType.GetCompoundStructure();
        if (cs is not null)
        {
            var layers = cs.GetLayers();
            if (layers.Count > 0 && thicknessFeet > 0)
            {
                cs.SetLayerWidth(0, thicknessFeet);
                SetStructure(newType, cs);
            }
        }

        return newType;
    }

    public static FamilySymbol ResolveOrCreateColumnType(Document doc, string? shape, double sizeXMeters, double sizeYMeters)
    {
        var sizeXMm = (int)Math.Round(sizeXMeters * 1000);
        var sizeYMm = (int)Math.Round(sizeYMeters * 1000);
        var shapeStr = shape ?? "rect";
        var targetName = $"BimDown_{shapeStr}_{sizeXMm}x{sizeYMm}";

        var existing = new FilteredElementCollector(doc)
            .OfCategory(BuiltInCategory.OST_Columns)
            .OfClass(typeof(FamilySymbol))
            .Cast<FamilySymbol>()
            .FirstOrDefault(fs => fs.Name == targetName);
        if (existing is not null)
        {
            if (!existing.IsActive) existing.Activate();
            return existing;
        }

        var template = new FilteredElementCollector(doc)
            .OfCategory(BuiltInCategory.OST_Columns)
            .OfClass(typeof(FamilySymbol))
            .Cast<FamilySymbol>()
            .FirstOrDefault();

        if (template is null)
            throw new InvalidOperationException("No column FamilySymbol found to duplicate");

        var newType = (FamilySymbol)template.Duplicate(targetName);
        if (!newType.IsActive) newType.Activate();
        return newType;
    }

    public static FamilySymbol ResolveOrCreateDoorType(Document doc, double widthMeters, double heightMeters)
    {
        var wMm = (int)Math.Round(widthMeters * 1000);
        var hMm = (int)Math.Round(heightMeters * 1000);
        var targetName = $"BimDown_{wMm}x{hMm}";

        return ResolveOrCreateOpeningType(doc, BuiltInCategory.OST_Doors, targetName, widthMeters, heightMeters);
    }

    public static FamilySymbol ResolveOrCreateWindowType(Document doc, double widthMeters, double heightMeters)
    {
        var wMm = (int)Math.Round(widthMeters * 1000);
        var hMm = (int)Math.Round(heightMeters * 1000);
        var targetName = $"BimDown_{wMm}x{hMm}";

        return ResolveOrCreateOpeningType(doc, BuiltInCategory.OST_Windows, targetName, widthMeters, heightMeters);
    }

    public static FamilySymbol ResolveOrCreateStructuralColumnType(Document doc, string? shape, double sizeXMeters, double sizeYMeters)
    {
        var sizeXMm = (int)Math.Round(sizeXMeters * 1000);
        var sizeYMm = (int)Math.Round(sizeYMeters * 1000);
        var shapeStr = shape ?? "rect";
        var targetName = $"BimDown_struct_{shapeStr}_{sizeXMm}x{sizeYMm}";

        var existing = new FilteredElementCollector(doc)
            .OfCategory(BuiltInCategory.OST_StructuralColumns)
            .OfClass(typeof(FamilySymbol))
            .Cast<FamilySymbol>()
            .FirstOrDefault(fs => fs.Name == targetName);
        if (existing is not null)
        {
            if (!existing.IsActive) existing.Activate();
            return existing;
        }

        var template = new FilteredElementCollector(doc)
            .OfCategory(BuiltInCategory.OST_StructuralColumns)
            .OfClass(typeof(FamilySymbol))
            .Cast<FamilySymbol>()
            .FirstOrDefault()
            ?? throw new InvalidOperationException("No structural column FamilySymbol found to duplicate");

        var newType = (FamilySymbol)template.Duplicate(targetName);
        if (!newType.IsActive) newType.Activate();
        return newType;
    }

    public static FamilySymbol ResolveOrCreateStructuralFramingType(Document doc, string? shape, double sizeXMeters, double sizeYMeters)
    {
        var sizeXMm = (int)Math.Round(sizeXMeters * 1000);
        var sizeYMm = (int)Math.Round(sizeYMeters * 1000);
        var shapeStr = shape ?? "rect";
        var targetName = $"BimDown_framing_{shapeStr}_{sizeXMm}x{sizeYMm}";

        var existing = new FilteredElementCollector(doc)
            .OfCategory(BuiltInCategory.OST_StructuralFraming)
            .OfClass(typeof(FamilySymbol))
            .Cast<FamilySymbol>()
            .FirstOrDefault(fs => fs.Name == targetName);
        if (existing is not null)
        {
            if (!existing.IsActive) existing.Activate();
            return existing;
        }

        var template = new FilteredElementCollector(doc)
            .OfCategory(BuiltInCategory.OST_StructuralFraming)
            .OfClass(typeof(FamilySymbol))
            .Cast<FamilySymbol>()
            .FirstOrDefault()
            ?? throw new InvalidOperationException("No structural framing FamilySymbol found to duplicate");

        var newType = (FamilySymbol)template.Duplicate(targetName);
        if (!newType.IsActive) newType.Activate();
        return newType;
    }

    public static WallType FindCurtainWallType(Document doc)
    {
        return new FilteredElementCollector(doc)
            .OfClass(typeof(WallType))
            .Cast<WallType>()
            .FirstOrDefault(wt => wt.Kind == WallKind.Curtain)
            ?? throw new InvalidOperationException("No curtain WallType found");
    }

    public static FamilySymbol FindFirstFamilySymbol(Document doc, BuiltInCategory category)
    {
        var symbol = new FilteredElementCollector(doc)
            .OfCategory(category)
            .OfClass(typeof(FamilySymbol))
            .Cast<FamilySymbol>()
            .FirstOrDefault()
            ?? LibrarySymbol(doc, category, LibraryKeywords.GetValueOrDefault(category) ?? [])
            ?? throw new InvalidOperationException($"No FamilySymbol found for {category}");
        if (!symbol.IsActive) symbol.Activate();
        return symbol;
    }

    /// <summary>Content-library file names to load when a template has no family of a category.</summary>
    static readonly Dictionary<BuiltInCategory, string[]> LibraryKeywords = new()
    {
        [BuiltInCategory.OST_StructuralFoundation] = ["Footing-Rectangular", "Footing"],
        [BuiltInCategory.OST_StructuralColumns] = ["Concrete-Rectangular-Column", "Column"],
        [BuiltInCategory.OST_StructuralFraming] = ["Concrete-Rectangular Beam", "Beam"],
    };

    static FamilySymbol ResolveOrCreateOpeningType(Document doc, BuiltInCategory category, string targetName,
        double widthMeters, double heightMeters)
    {
        var existing = new FilteredElementCollector(doc)
            .OfCategory(category)
            .OfClass(typeof(FamilySymbol))
            .Cast<FamilySymbol>()
            .FirstOrDefault(fs => fs.Name == targetName);
        if (existing is not null)
        {
            if (!existing.IsActive) existing.Activate();
            return existing;
        }

        var template = new FilteredElementCollector(doc)
            .OfCategory(category)
            .OfClass(typeof(FamilySymbol))
            .Cast<FamilySymbol>()
            .FirstOrDefault();

        if (template is null)
            throw new InvalidOperationException($"No FamilySymbol found for {category} to duplicate");

        var newType = (FamilySymbol)template.Duplicate(targetName);

        // Try to set width/height parameters
        var widthFeet = UnitConverter.LengthToFeet(widthMeters);
        var heightFeet = UnitConverter.LengthToFeet(heightMeters);

        newType.get_Parameter(BuiltInParameter.FAMILY_WIDTH_PARAM)?.Set(widthFeet);
        newType.get_Parameter(BuiltInParameter.FAMILY_HEIGHT_PARAM)?.Set(heightFeet);
        newType.get_Parameter(BuiltInParameter.DOOR_WIDTH)?.Set(widthFeet);
        newType.get_Parameter(BuiltInParameter.DOOR_HEIGHT)?.Set(heightFeet);
        newType.get_Parameter(BuiltInParameter.WINDOW_WIDTH)?.Set(widthFeet);
        newType.get_Parameter(BuiltInParameter.WINDOW_HEIGHT)?.Set(heightFeet);

        if (!newType.IsActive) newType.Activate();
        return newType;
    }

    // ─── Typed resolution (type_id → named Revit type) ──────────────────

    static ElementId MaterialByName(Document doc, string? name, string? fallbackEnum)
    {
        var target = string.IsNullOrWhiteSpace(name) ? fallbackEnum : name;
        if (string.IsNullOrWhiteSpace(target)) return ElementId.InvalidElementId;
        var existing = new FilteredElementCollector(doc).OfClass(typeof(Material)).Cast<Material>()
            .FirstOrDefault(m => string.Equals(m.Name, target, StringComparison.OrdinalIgnoreCase));
        return existing?.Id ?? Material.Create(doc, target);
    }

    /// <summary>
    /// Compound structure from type_layer rows (seq 1 = exterior / top, Revit's
    /// layer 0). The core layers are the shell boundaries; without a core layer
    /// the thickest layer is the core.
    /// </summary>
    static CompoundStructure? BuildStructure(Document doc, IReadOnlyList<Dictionary<string, string?>> layers)
    {
        if (layers.Count == 0) return null;
        var coreIdx = layers.Select((l, i) => (l, i)).Where(x => x.l.GetValueOrDefault("function") == "core").Select(x => x.i).ToList();
        if (coreIdx.Count == 0)
        {
            var thickest = layers.Select((l, i) => (T: UnitConverter.ParseNullableDouble(l.GetValueOrDefault("thickness")) ?? 0, I: i)).MaxBy(x => x.T).I;
            coreIdx.Add(thickest);
        }
        var first = coreIdx.Min();
        var last = coreIdx.Max();
        var list = new List<CompoundStructureLayer>();
        for (var i = 0; i < layers.Count; i++)
        {
            var l = layers[i];
            var function = coreIdx.Contains(i) ? "core" : l.GetValueOrDefault("function");
            var fn = Enum.Parse<MaterialFunctionAssignment>(Mapping.LayerMapper.RevitFunction(function, i < first));
            var width = UnitConverter.LengthToFeet(UnitConverter.ParseNullableDouble(l.GetValueOrDefault("thickness")) ?? 0.01);
            list.Add(new CompoundStructureLayer(width, fn, MaterialByName(doc, l.GetValueOrDefault("name"), l.GetValueOrDefault("material"))));
        }
        var cs = CompoundStructure.CreateSimpleCompoundStructure(list);
        cs.SetNumberOfShellLayers(ShellLayerType.Exterior, first);
        cs.SetNumberOfShellLayers(ShellLayerType.Interior, layers.Count - 1 - last);
        return cs;
    }

    /// <summary>
    /// The Revit type named like a BimDown layered type (wall_type, slab_type,
    /// roof_type, ceiling_type), else a duplicate of the first matching type with
    /// that name and the type's layers.
    /// </summary>
    public static T? ResolveLayeredType<T>(Document doc, string? typeId, Func<T, bool>? filter = null) where T : HostObjAttributes
    {
        if (ImportContext.Type(typeId) is not { } typeRow || typeRow.GetValueOrDefault("name") is not { } name) return null;
        var all = new FilteredElementCollector(doc).OfClass(typeof(T)).Cast<T>().Where(t => filter is null || filter(t)).ToList();
        var existing = all.FirstOrDefault(t => t.Name == name);
        if (existing is not null) return existing;
        var template = all.FirstOrDefault();
        if (template is null) return null;
        var created = (T)template.Duplicate(name);
        var cs = BuildStructure(doc, ImportContext.LayersOf(typeId));
        if (cs is null && UnitConverter.ParseNullableDouble(typeRow.GetValueOrDefault("thickness")) is { } th)
        {
            cs = created.GetCompoundStructure();
            if (cs is not null && cs.GetLayers().Count > 0)
                cs.SetLayerWidth(Math.Max(0, cs.GetFirstCoreLayerIndex()), UnitConverter.LengthToFeet(th));
        }
        if (cs is not null) SetStructure(created, cs);
        return created;
    }

    static readonly Dictionary<string, FamilySymbol?> LibrarySymbols = new();

    /// <summary>
    /// A family from Revit's content library (Options ▸ File Locations ▸ Places) for a
    /// category the model has no family of, picked by file-name keywords in order
    /// (hosted / face-based and tag families skipped). Null when nothing matches.
    /// </summary>
    public static FamilySymbol? LibrarySymbol(Document doc, BuiltInCategory category, params string[] keywords)
    {
        var key = $"{doc.PathName}|{doc.Title}|{category}|{string.Join(",", keywords)}";
        if (LibrarySymbols.TryGetValue(key, out var cached) && (cached is null || cached.IsValidObject)) return cached;
        FamilySymbol? found = null;
        try
        {
            var files = doc.Application.GetLibraryPaths().Values.Where(Directory.Exists).Distinct()
                .SelectMany(root => Directory.EnumerateFiles(root, "*.rfa", SearchOption.AllDirectories))
                .Where(f => !Path.GetFileName(f).Contains("Tag", StringComparison.OrdinalIgnoreCase)
                            && !Path.GetFileName(f).Contains("Hosted", StringComparison.OrdinalIgnoreCase)
                            && !Path.GetFileName(f).Contains("Face Based", StringComparison.OrdinalIgnoreCase)
                            && !f.Contains("Annotation", StringComparison.OrdinalIgnoreCase)
                            && !f.Contains("Detail Items", StringComparison.OrdinalIgnoreCase))
                .ToList();
            foreach (var kw in keywords)
            {
                foreach (var file in files.Where(f => Path.GetFileNameWithoutExtension(f).Contains(kw, StringComparison.OrdinalIgnoreCase)).OrderBy(f => Path.GetFileName(f).Length))
                {
                    var name = Path.GetFileNameWithoutExtension(file);
                    var family = new FilteredElementCollector(doc).OfClass(typeof(Family)).Cast<Family>().FirstOrDefault(f => f.Name == name);
                    if (family is null && !doc.LoadFamily(file, out family)) continue;
                    if (family?.FamilyCategory?.BuiltInCategory != category) continue;
                    if (family.GetFamilySymbolIds().Select(doc.GetElement).OfType<FamilySymbol>().FirstOrDefault() is not { } symbol) continue;
                    if (!symbol.IsActive) symbol.Activate();
                    found = symbol;
                    break;
                }
                if (found is not null) break;
            }
        }
        catch { found = null; }
        LibrarySymbols[key] = found;
        return found;
    }

    /// <summary>
    /// Floors and roofs reject a structure built for walls ("wrong EndCap condition for
    /// this element type"): retry with the other end-cap conditions; keep the duplicated
    /// type's own structure when none is accepted.
    /// </summary>
    static void SetStructure(HostObjAttributes type, CompoundStructure cs)
    {
        try { type.SetCompoundStructure(cs); return; }
        catch (Exception) { }
        foreach (var cap in Enum.GetValues<EndCapCondition>().Where(c => c != cs.EndCap))
        {
            try { cs.EndCap = cap; type.SetCompoundStructure(cs); return; }
            catch (Exception) { }
        }
    }

    /// <summary>The family type named like a BimDown type (door / window / column / beam / foundation / furniture type).</summary>
    public static FamilySymbol? ResolveNamedSymbol(Document doc, string? typeId, params BuiltInCategory[] categories)
    {
        if (ImportContext.Type(typeId) is not { } typeRow) return null;
        var names = new[] { typeRow.GetValueOrDefault("name"), typeRow.GetValueOrDefault("designation") }
            .Where(n => !string.IsNullOrWhiteSpace(n)).ToList();
        foreach (var cat in categories)
        {
            var symbol = new FilteredElementCollector(doc).OfCategory(cat).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>()
                .FirstOrDefault(fs => names.Any(n => string.Equals(fs.Name, n, StringComparison.OrdinalIgnoreCase)
                                                  || string.Equals(fs.FamilyName + ": " + fs.Name, n, StringComparison.OrdinalIgnoreCase)));
            if (symbol is null) continue;
            if (!symbol.IsActive) symbol.Activate();
            return symbol;
        }
        return null;
    }

    /// <summary>Door / window type from door_type / window_type: the named symbol, else a sized duplicate with that name.</summary>
    public static FamilySymbol? ResolveOpeningType(Document doc, string? typeId, BuiltInCategory category)
    {
        if (ResolveNamedSymbol(doc, typeId, category) is { } named) return named;
        if (ImportContext.Type(typeId) is not { } t || t.GetValueOrDefault("name") is not { } name) return null;
        var w = UnitConverter.ParseNullableDouble(t.GetValueOrDefault("width"));
        var h = UnitConverter.ParseNullableDouble(t.GetValueOrDefault("height"));
        if (w is null || h is null) return null;
        return ResolveOrCreateOpeningType(doc, category, name, w.Value, h.Value);
    }

    /// <summary>
    /// Wall type for a wall row: its wall_type (by name, created with its layers)
    /// unless the row overrides the thickness, else a BimDown_{mm} type.
    /// </summary>
    public static WallType WallTypeFor(Document doc, Dictionary<string, string?> row, double thicknessMeters)
    {
        var typed = ResolveLayeredType<WallType>(doc, row.GetValueOrDefault("type_id"), wt => wt.Kind == WallKind.Basic);
        if (typed is not null && Math.Abs(UnitConverter.Length(typed.Width) - thicknessMeters) < 5e-4) return typed;
        return ResolveOrCreateWallType(doc, thicknessMeters);
    }

    /// <summary>Floor type for a slab / foundation row (slab_type by name unless the thickness is overridden).</summary>
    public static FloorType FloorTypeFor(Document doc, Dictionary<string, string?> row, double thicknessMeters)
    {
        var typed = ResolveLayeredType<FloorType>(doc, row.GetValueOrDefault("type_id"));
        if (typed?.GetCompoundStructure() is { } cs && Math.Abs(UnitConverter.Length(cs.GetWidth()) - thicknessMeters) < 5e-4) return typed;
        return ResolveOrCreateFloorType(doc, thicknessMeters);
    }
}
