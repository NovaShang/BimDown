using Autodesk.Revit.DB;
using BimDown.RevitAddin.Mapping;

namespace BimDown.RevitAddin.Extractors;

/// <summary>
/// system_type: the short tag of the element's MEP system (the system type's
/// Abbreviation, else the code of its classification — SA, CHWS, DCW, SAN, …),
/// the same tag mep_system.csv and connector.csv use.
/// </summary>
public class MepSystemExtractor : IFieldExtractor
{
    public IReadOnlyList<string> FieldNames { get; } = ["system_type"];

    public Dictionary<string, string?> Extract(Element element) =>
        new() { ["system_type"] = SystemTag(element) };

    internal static string? SystemTag(Element element)
    {
        MEPSystem? sys = null;
        try
        {
            if (element is MEPCurve curve) sys = curve.MEPSystem;
            else if (element is FamilyInstance fi && fi.MEPModel?.ConnectorManager?.Connectors is { } conns)
                foreach (Connector c in conns)
                {
                    if (c.Domain == Domain.DomainElectrical) continue;
                    try { sys = c.MEPSystem; } catch { }
                    if (sys is not null) break;
                }
        }
        catch { }
        return FromSystem(element.Document, sys)
            ?? Fallback(element);
    }

    internal static string? FromSystem(Document doc, MEPSystem? sys)
    {
        if (sys is null) return null;
        if (doc.GetElement(sys.GetTypeId()) is MEPSystemType mst)
            return MepMapper.SystemTag(mst.Abbreviation, mst.SystemClassification.ToString(), mst.Name);
        return null;
    }

    static string? Fallback(Element element)
    {
        var abbr = element.get_Parameter(BuiltInParameter.RBS_DUCT_PIPE_SYSTEM_ABBREVIATION_PARAM)?.AsString();
        if (!string.IsNullOrWhiteSpace(abbr)) return abbr.Trim().ToUpperInvariant();
        var classification = element.get_Parameter(BuiltInParameter.RBS_SYSTEM_CLASSIFICATION_PARAM)?.AsString();
        if (string.IsNullOrWhiteSpace(classification)) return null;
        // The parameter holds the display name ("Supply Air"); map the common ones.
        var key = classification.Replace(" ", "");
        return MepMapper.SystemTag(null, key, classification);
    }
}
