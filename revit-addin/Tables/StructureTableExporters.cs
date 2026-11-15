using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Structure;
using BimDown.RevitAddin.Extractors;

namespace BimDown.RevitAddin.Tables;

public static class StructureTableExporters
{
    public static ITableExporter StructureWall() => new TableExporter(
        "structure_wall",
        [BuiltInCategory.OST_Walls],
        new CompositeExtractor(
            [..CompositeExtractor.ExpandLineElement(), new VerticalSpanExtractor(), new MaterializedExtractor()],
            ["thickness"],
            e => new Dictionary<string, string?>
            {
                ["thickness"] = e is Wall w
                    ? UnitConverter.FormatDouble(UnitConverter.Length(w.Width))
                    : null
            }),
        e => e is Wall w && w.StructuralUsage != StructuralWallUsage.NonBearing);

    public static ITableExporter StructureColumn() => new TableExporter(
        "structure_column",
        [BuiltInCategory.OST_StructuralColumns],
        new CompositeExtractor(
            [..CompositeExtractor.ExpandPointElement(), new VerticalSpanExtractor(), new MaterializedExtractor(), new StructuralSectionProfileExtractor()]));

    public static ITableExporter StructureSlab() => new TableExporter(
        "structure_slab",
        [BuiltInCategory.OST_Floors],
        new CompositeExtractor(
            [..CompositeExtractor.ExpandPolygonElement(), new MaterializedExtractor()],
            ["function", "thickness"],
            e =>
            {
                var fields = new Dictionary<string, string?> { ["function"] = SlabFunction(e) };
                var thickness = e.get_Parameter(BuiltInParameter.FLOOR_ATTR_THICKNESS_PARAM)?.AsDouble();
                fields["thickness"] = thickness is { } t ? UnitConverter.FormatDouble(UnitConverter.Length(t)) : null;
                return fields;
            }),
        e =>
        {
            if (e is not Floor) return false;
            var structural = e.get_Parameter(BuiltInParameter.FLOOR_PARAM_IS_STRUCTURAL)?.AsInteger();
            return structural == 1;
        });

    /// <summary>
    /// "roof" for a floor that closes the building, else "floor": an explicit IFC
    /// export class (Export to IFC As = IfcRoof / IfcSlab.ROOF), a type named as a
    /// roof, or a slab on the top level of the model.
    /// </summary>
    public static string SlabFunction(Element e)
    {
        var ifcAs = $"{ParameterUtils.FindStringParameterByNames(e, "IfcExportAs", "Export to IFC As")} {ParameterUtils.FindStringParameterByNames(e, "IfcExportType", "Type IFC Predefined Type", "IFC Predefined Type")}";
        if (ifcAs.Contains("ROOF", StringComparison.OrdinalIgnoreCase)) return "roof";
        var typeName = e.Document.GetElement(e.GetTypeId())?.Name ?? "";
        if (typeName.Contains("roof", StringComparison.OrdinalIgnoreCase) || typeName.Contains("屋面") || typeName.Contains("屋顶")) return "roof";
        if (e.Document.GetElement(e.LevelId) is Level level)
        {
            var top = new FilteredElementCollector(e.Document).OfClass(typeof(Level)).Cast<Level>().Max(l => l.Elevation);
            if (Math.Abs(level.Elevation - top) < 1e-6) return "roof";
        }
        return "floor";
    }

    public static ITableExporter Beam() => new TableExporter(
        "beam",
        [BuiltInCategory.OST_StructuralFraming],
        new CompositeExtractor(
            [..CompositeExtractor.ExpandSpatialLineElement(), new StructuralSectionProfileExtractor(), new MaterializedExtractor()]),
        e => e is FamilyInstance fi && fi.StructuralType == StructuralType.Beam);

    public static ITableExporter Brace() => new TableExporter(
        "brace",
        [BuiltInCategory.OST_StructuralFraming],
        new CompositeExtractor(
            [..CompositeExtractor.ExpandSpatialLineElement(), new StructuralSectionProfileExtractor(), new MaterializedExtractor()]),
        e => e is FamilyInstance fi && fi.StructuralType == StructuralType.Brace);

    public static ITableExporter Foundation() => new TableExporter(
        "foundation",
        [BuiltInCategory.OST_StructuralFoundation],
        new CompositeExtractor(
            [new ElementExtractor(), new FoundationExtractor(), new MaterializedExtractor()]));
}
