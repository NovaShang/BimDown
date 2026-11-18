using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Structure;
using BimDown.RevitAddin.Mapping;
using static BimDown.RevitAddin.Extractors.ParameterUtils;
using static BimDown.RevitAddin.RevitReaders;

namespace BimDown.RevitAddin.Extractors;

/// <summary>
/// Unified extractor for all foundation forms: foundation slabs → raft Polygon,
/// wall foundations → strip LineString along their wall, isolated families →
/// pad / pile Point, pile caps → their rectangle as a Polygon. `kind` comes
/// from FoundationMapper (class + family naming).
/// </summary>
public class FoundationExtractor : IFieldExtractor
{
    public IReadOnlyList<string> FieldNames { get; } =
        ["kind", "thickness", "width", "length", "material_grade", "x", "y", "rotation", "start_x", "start_y", "end_x", "end_y", "points", "area"];

    public IReadOnlyList<string> ComputedFieldNames { get; } =
        ["x", "y", "rotation", "start_x", "start_y", "end_x", "end_y", "points", "area"];

    public Dictionary<string, string?> Extract(Element element)
    {
        var fields = new Dictionary<string, string?>
        {
            ["material_grade"] = MaterialMapper.MaterialGrade(StructuralMaterialName(element)),
        };

        if (element is Floor)
        {
            fields["kind"] = "raft";
            var thickness = element.get_Parameter(BuiltInParameter.FLOOR_ATTR_THICKNESS_PARAM).AsPositiveDouble();
            fields["thickness"] = thickness is { } tv ? Names.Num(M(tv), 3) : null;
            var polygon = GeometryUtils.GetTopFacePolygon(element);
            if (polygon is not null)
            {
                fields["points"] = GeometryUtils.SerializePolygon(polygon.Value.Points);
                if (polygon.Value.HasCurvedEdges)
                    fields["_has_curved_edges"] = "true";
            }
            return fields;
        }

        if (element is WallFoundation wf)
        {
            fields["kind"] = "strip";
            var type = element.Document.GetElement(wf.GetTypeId());
            var w = type?.get_Parameter(BuiltInParameter.CONTINUOUS_FOOTING_WIDTH).AsPositiveDouble()
                 ?? element.get_Parameter(BuiltInParameter.CONTINUOUS_FOOTING_WIDTH).AsPositiveDouble();
            var t = type?.get_Parameter(BuiltInParameter.STRUCTURAL_FOUNDATION_THICKNESS).AsPositiveDouble();
            fields["width"] = w is { } wv ? Names.Num(M(wv), 3) : null;
            fields["thickness"] = t is { } tv ? Names.Num(M(tv), 3) : null;
            if (element.Document.GetElement(wf.WallId) is Wall wall && wall.Location is LocationCurve { Curve: Line line })
            {
                var a = line.GetEndPoint(0);
                var b = line.GetEndPoint(1);
                fields["start_x"] = Names.Num(M(a.X)); fields["start_y"] = Names.Num(M(a.Y));
                fields["end_x"] = Names.Num(M(b.X)); fields["end_y"] = Names.Num(M(b.Y));
                // The strip's top is at the wall base; its level is the wall's.
                fields["level_id"] = element.Document.GetElement(wall.LevelId)?.UniqueId;
                var bo = wall.get_Parameter(BuiltInParameter.WALL_BASE_OFFSET)?.AsDouble() ?? 0;
                fields["base_offset"] = Math.Abs(bo) > 1e-9 ? Names.Num(M(bo), 3) : null;
            }
            return fields;
        }

        var fi = element as FamilyInstance;
        var kind = FoundationMapper.Kind("FamilyInstance", fi?.Symbol?.FamilyName ?? "", fi?.Symbol?.Name ?? "");
        fields["kind"] = kind;

        var width = element.get_Parameter(BuiltInParameter.STRUCTURAL_FOUNDATION_WIDTH).AsPositiveDouble()
                 ?? FindDoubleParameterByNames(element, "width", "diameter", "pile diameter", "b", "宽度", "直径");
        var length = element.get_Parameter(BuiltInParameter.STRUCTURAL_FOUNDATION_LENGTH).AsPositiveDouble()
                  ?? FindDoubleParameterByNames(element, "length", "l", "长度");
        var thick = element.get_Parameter(BuiltInParameter.STRUCTURAL_FOUNDATION_THICKNESS).AsPositiveDouble()
                 ?? (kind == "pile" ? FindDoubleParameterByNames(element, "pile length", "length", "桩长")
                                    : FindDoubleParameterByNames(element, "thickness", "foundation thickness", "h", "厚度"));

        if (element.Location is LocationPoint lp)
        {
            var bb = fi?.Symbol?.get_BoundingBox(null) ?? element.get_BoundingBox(null);
            if (bb is not null && (width is null || (kind != "pile" && length is null)))
            {
                width ??= bb.Max.X - bb.Min.X;
                if (kind != "pile") length ??= bb.Max.Y - bb.Min.Y;
            }
            if (kind == "pile" && length is { } pl && thick is { } pt && Math.Abs(pl - pt) < 1e-6) length = null;

            var x = M(lp.Point.X);
            var y = M(lp.Point.Y);
            var rot = UnitConverter.Angle(lp.Rotation);
            if (kind == "pile_cap" && width is { } cw)
            {
                // Pile caps are Polygon foundations at their real footprint.
                var pts = FoundationMapper.RectFootprint(x, y, M(cw), M(length ?? cw), rot);
                fields["points"] = "[" + string.Join(",", pts.Select(p => $"[{Names.Num(p.X)},{Names.Num(p.Y)}]")) + "]";
            }
            else
            {
                fields["x"] = Names.Num(x);
                fields["y"] = Names.Num(y);
                fields["rotation"] = Names.Num(rot);
            }
        }
        else if (element.Location is LocationCurve { Curve: Line line })
        {
            var a = line.GetEndPoint(0);
            var b = line.GetEndPoint(1);
            fields["kind"] = "strip";
            fields["start_x"] = Names.Num(M(a.X)); fields["start_y"] = Names.Num(M(a.Y));
            fields["end_x"] = Names.Num(M(b.X)); fields["end_y"] = Names.Num(M(b.Y));
        }

        fields["width"] = width is { } wv2 ? Names.Num(M(wv2), 3) : null;
        fields["length"] = length is { } lv ? Names.Num(M(lv), 3) : null;
        fields["thickness"] = thick is { } tv2 ? Names.Num(M(tv2), 3) : null;
        return fields;
    }
}
