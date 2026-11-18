using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using BimDown.RevitAddin.Mapping;
using static BimDown.RevitAddin.RevitReaders;

namespace BimDown.RevitAddin.Tables;

/// <summary>
/// Plan annotations of one floor plan per level (the plan named like the level,
/// else the first one): text notes, element / room tags and linear dimensions.
/// Annotations of other views (sections, sheets, duplicate plans) are not exported.
/// </summary>
public class AnnotationTableExporter(string tableName) : ITableExporter
{
    public string TableName => tableName;

    public IReadOnlyList<string> Columns { get; } = tableName switch
    {
        "text_note" => ["id", "x", "y", "text", "paper_size", "rotation"],
        "tag" => ["id", "host_id", "x", "y", "content"],
        _ => ["id", "start_x", "start_y", "end_x", "end_y", "start_ref", "end_ref", "direction", "offset", "text"],
    };

    public IReadOnlyList<string> CsvColumns => Columns;

    /// <summary>Level → its main floor plan.</summary>
    internal static Dictionary<ElementId, ViewPlan> PlanViews(Document doc)
    {
        var result = new Dictionary<ElementId, ViewPlan>();
        var plans = new FilteredElementCollector(doc).OfClass(typeof(ViewPlan)).Cast<ViewPlan>()
            .Where(v => !v.IsTemplate && v.ViewType == ViewType.FloorPlan && v.GenLevel is not null)
            .OrderBy(v => v.Id.Value);
        foreach (var g in plans.GroupBy(v => v.GenLevel.Id))
            result[g.Key] = g.FirstOrDefault(v => v.Name == v.GenLevel.Name) ?? g.First();
        return result;
    }

    public List<Dictionary<string, string?>> Export(Document doc)
    {
        var rows = new List<Dictionary<string, string?>>();
        foreach (var (levelId, view) in PlanViews(doc))
        {
            var levelUid = doc.GetElement(levelId)?.UniqueId;
            foreach (var e in new FilteredElementCollector(doc, view.Id).WhereElementIsNotElementType().OrderBy(e => e.Id.Value))
            {
                try
                {
                    foreach (var row in Rows(doc, e))
                    {
                        row["level_id"] = levelUid;
                        rows.Add(row);
                    }
                }
                catch { /* skip unreadable annotations */ }
            }
        }
        return rows;
    }

    IEnumerable<Dictionary<string, string?>> Rows(Document doc, Element e)
    {
        switch (tableName)
        {
            case "text_note" when e is TextNote tn:
            {
                var size = doc.GetElement(tn.GetTypeId())?.get_Parameter(BuiltInParameter.TEXT_SIZE)?.AsDouble();
                var rot = AnnotationMapper.RotationDeg(tn.BaseDirection.X, tn.BaseDirection.Y);
                yield return new Dictionary<string, string?>
                {
                    ["id"] = tn.UniqueId,
                    ["x"] = Names.Num(M(tn.Coord.X)),
                    ["y"] = Names.Num(M(tn.Coord.Y)),
                    // A literal "\n" starts a new line in BimDown text.
                    ["text"] = tn.Text.TrimEnd('\r', '\n').Replace("\r\n", "\\n").Replace("\r", "\\n").Replace("\n", "\\n"),
                    ["paper_size"] = size is > 0 ? Names.Num(AnnotationMapper.PaperSizeMm(M(size.Value)), 2) : null,
                    ["rotation"] = rot == 0 ? null : Names.Num(rot, 2),
                };
                break;
            }
            case "tag" when e is IndependentTag it:
            {
                var host = it.GetTaggedLocalElementIds().FirstOrDefault(id => id != ElementId.InvalidElementId);
                if (host is null || doc.GetElement(host) is not { } h) yield break;
                var p = it.TagHeadPosition;
                yield return new Dictionary<string, string?>
                {
                    ["id"] = it.UniqueId, ["host_id"] = h.UniqueId,
                    ["x"] = Names.Num(M(p.X)), ["y"] = Names.Num(M(p.Y)),
                };
                break;
            }
            case "tag" when e is RoomTag rt:
            {
                if (rt.TaggedLocalRoomId is not { } rid || rid == ElementId.InvalidElementId || doc.GetElement(rid) is not { } room) yield break;
                var p = rt.TagHeadPosition;
                yield return new Dictionary<string, string?>
                {
                    ["id"] = rt.UniqueId, ["host_id"] = room.UniqueId,
                    ["x"] = Names.Num(M(p.X)), ["y"] = Names.Num(M(p.Y)),
                };
                break;
            }
            case "dimension" when e is Dimension { DimensionShape: DimensionShape.Linear } dim && dim.Curve is Line line:
            {
                var segs = new List<DimensionSegmentInput>();
                if (dim.NumberOfSegments == 0)
                {
                    if (dim.Value is { } v)
                        segs.Add(new DimensionSegmentInput(M(dim.Origin.X), M(dim.Origin.Y), M(v), dim.ValueOverride));
                }
                else
                {
                    foreach (DimensionSegment s in dim.Segments)
                        if (s.Value is { } sv)
                            segs.Add(new DimensionSegmentInput(M(s.Origin.X), M(s.Origin.Y), M(sv), s.ValueOverride));
                }
                foreach (var row in AnnotationMapper.DimensionRows(dim.UniqueId, line.Direction.X, line.Direction.Y, segs))
                    yield return row;
                break;
            }
        }
    }
}
