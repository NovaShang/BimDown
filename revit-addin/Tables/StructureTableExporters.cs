using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Structure;
using BimDown.RevitAddin.Extractors;
using BimDown.RevitAddin.Mapping;
using static BimDown.RevitAddin.RevitReaders;

namespace BimDown.RevitAddin.Tables;

public static class StructureTableExporters
{
    public static ITableExporter StructureWall() => new TableExporter(
        "structure_wall",
        [BuiltInCategory.OST_Walls],
        ArchitectureTableExporters.WallExtractor(structural: true),
        e => e is Wall w && w.WallType.Kind == WallKind.Basic && w.StructuralUsage != StructuralWallUsage.NonBearing);

    /// <summary>
    /// Structural section of a framing / column instance: the type's section
    /// (StructuralSection API, family dimension parameters, catalogue designation)
    /// plus the strength grade of its structural material.
    /// </summary>
    static Dictionary<string, string?> SectionFields(Element e)
    {
        var f = e is FamilyInstance fi ? SectionMapper.Map(Section(fi.Symbol)) : new Dictionary<string, string?> { ["shape"] = "rect" };
        f["material_grade"] = MaterialMapper.MaterialGrade(StructuralMaterialName(e));
        return f;
    }

    static readonly string[] SectionFieldNames = ["shape", "size_x", "size_y", "flange", "web", "thickness", "root_radius", "designation", "material_grade"];

    public static ITableExporter StructureColumn() => new TableExporter(
        "structure_column",
        [BuiltInCategory.OST_StructuralColumns],
        new CompositeExtractor(
            [.. CompositeExtractor.ExpandPointElement(), new VerticalSpanExtractor(), new MaterializedExtractor(), new TypeIdExtractor()],
            SectionFieldNames,
            SectionFields));

    public static ITableExporter StructureSlab() => new TableExporter(
        "structure_slab",
        [BuiltInCategory.OST_Floors],
        ArchitectureTableExporters.SlabExtractor(structural: true),
        e => e is Floor && e.get_Parameter(BuiltInParameter.FLOOR_PARAM_IS_STRUCTURAL)?.AsInteger() == 1);

    /// <summary>
    /// "roof" for a floor that closes the building, else "floor": an explicit IFC
    /// export class (Export to IFC As = IfcRoof / IfcSlab.ROOF), a type named as a
    /// roof, or a slab on the top level of the model.
    /// </summary>
    public static string SlabFunction(Element e)
    {
        var ifcAs = $"{Extractors.ParameterUtils.FindStringParameterByNames(e, "IfcExportAs", "Export to IFC As")} {Extractors.ParameterUtils.FindStringParameterByNames(e, "IfcExportType", "Type IFC Predefined Type", "IFC Predefined Type")}";
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

    static CompositeExtractor FramingExtractor(bool beam) => new(
        [.. CompositeExtractor.ExpandSpatialLineElement(), new MaterializedExtractor(), new TypeIdExtractor()],
        beam ? [.. SectionFieldNames, "beam_system_id"] : SectionFieldNames,
        e =>
        {
            var f = SectionFields(e);
            if (beam && e is FamilyInstance fi)
            {
                try { f["beam_system_id"] = BeamSystem.BeamBelongsTo(fi)?.UniqueId; }
                catch { }
            }
            return f;
        });

    public static ITableExporter Beam() => new TableExporter(
        "beam",
        [BuiltInCategory.OST_StructuralFraming],
        FramingExtractor(beam: true),
        e => e is FamilyInstance fi && fi.StructuralType == StructuralType.Beam);

    public static ITableExporter Brace() => new TableExporter(
        "brace",
        [BuiltInCategory.OST_StructuralFraming],
        FramingExtractor(beam: false),
        e => e is FamilyInstance fi && fi.StructuralType == StructuralType.Brace);

    /// <summary>
    /// Revit beam systems: bay polygon, spacing (fixed distance / maximum / clear
    /// spacing; a fixed number of beams becomes the equivalent spacing), direction
    /// and beam type. Their beams carry beam_system_id.
    /// </summary>
    public static ITableExporter BeamSystemTable() => new TableExporter(
        "beam_system",
        [BuiltInCategory.OST_StructuralFramingSystem],
        new CompositeExtractor(
            [new ElementExtractor()],
            ["spacing", "direction", "type_id", "material_grade", "points", "area"],
            e =>
            {
                var f = new Dictionary<string, string?>();
                if (e is not BeamSystem bs) return f;
                var pts = new List<XYZ>();
                foreach (Curve c in bs.Profile)
                    pts.Add(c.GetEndPoint(0));
                f["points"] = GeometryUtils.SerializePolygon(pts);
                var dir = bs.Direction;
                f["direction"] = Names.Num(AnnotationMapper.RotationDeg(dir.X, dir.Y) % 180, 2);
                double? spacing = bs.LayoutRule switch
                {
                    LayoutRuleFixedDistance fd => fd.Spacing,
                    LayoutRuleMaximumSpacing ms => ms.Spacing,
                    LayoutRuleClearSpacing cs => cs.Spacing,
                    LayoutRuleFixedNumber fn when fn.NumberOfLines > 0 => AcrossWidth(pts, dir) / (fn.NumberOfLines + 1),
                    _ => null,
                };
                // spacing is required: fall back to the bay width over the actual beam count.
                if (spacing is not > 0 && bs.GetBeamIds().Count is var count and > 0)
                    spacing = AcrossWidth(pts, dir) / (count + 1);
                f["spacing"] = spacing is > 0 ? Names.Num(M(spacing.Value), 3) : null;
                f["type_id"] = bs.BeamType?.UniqueId;
                f["base_offset"] = null;
                return f;
            },
            ["points", "area"]),
        e => e is BeamSystem);

    static double AcrossWidth(List<XYZ> pts, XYZ dir)
    {
        var n = new XYZ(-dir.Y, dir.X, 0);
        var d = pts.Select(p => p.DotProduct(n)).ToList();
        return d.Count == 0 ? 0 : d.Max() - d.Min();
    }

    public static ITableExporter Foundation() => new TableExporter(
        "foundation",
        [BuiltInCategory.OST_StructuralFoundation],
        new CompositeExtractor(
            [new ElementExtractor(), new FoundationExtractor(), new MaterializedExtractor(), new TypeIdExtractor()]));
}
