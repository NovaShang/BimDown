using Autodesk.Revit.DB;

namespace BimDown.RevitAddin.Extractors;

public class MepConnectedSegmentExtractor : IFieldExtractor
{
    public IReadOnlyList<string> FieldNames { get; } = ["from", "to"];

    public Dictionary<string, string?> Extract(Element element)
    {
        var fields = new Dictionary<string, string?>();

        var connectorSet = GetConnectors(element);
        if (connectorSet is null) return fields;

        // Collect all end connectors with their connected port reference.
        var connected = new List<(Connector Conn, string? PortRef)>();
        foreach (Connector conn in connectorSet)
        {
            if (conn.ConnectorType != ConnectorType.End) continue;
            connected.Add((conn, GetConnectedPortRef(conn)));
        }

        // If no End connectors found, try all physical connectors.
        if (connected.Count == 0)
        {
            foreach (Connector conn in connectorSet)
            {
                if (conn.ConnectorType is ConnectorType.End or ConnectorType.Curve or ConnectorType.Physical)
                    connected.Add((conn, GetConnectedPortRef(conn)));
            }
        }

        if (connected.Count == 0) return fields;

        // Assign from/to by flow direction first, then fill the rest by order.
        Connector? fromConn = null;
        Connector? toConn = null;
        string? fromRef = null;
        string? toRef = null;

        foreach (var (conn, refStr) in connected)
        {
            if (conn.Direction == FlowDirectionType.In && fromConn is null)
            {
                fromConn = conn;
                fromRef = refStr;
            }
            else if (conn.Direction == FlowDirectionType.Out && toConn is null)
            {
                toConn = conn;
                toRef = refStr;
            }
        }

        foreach (var (conn, refStr) in connected)
        {
            if (conn == fromConn || conn == toConn) continue;
            if (fromConn is null) { fromConn = conn; fromRef = refStr; }
            else if (toConn is null) { toConn = conn; toRef = refStr; }
        }

        if (fromRef is not null) fields["from"] = fromRef;
        if (toRef is not null) fields["to"] = toRef;

        return fields;
    }

    static ConnectorSet? GetConnectors(Element element)
    {
        if (element is MEPCurve mepCurve)
            return mepCurve.ConnectorManager?.Connectors;
        if (element is FamilyInstance fi)
            return fi.MEPModel?.ConnectorManager?.Connectors;
        return null;
    }

    /// <summary>
    /// Resolve a connector's connected counterpart to a "host_uid:port_name"
    /// reference. The port_name is derived from the other connector's
    /// Description (when present) or its ConnectorManager index ("c{index}").
    /// Returns null if the connector is not connected to anything physical.
    /// </summary>
    static string? GetConnectedPortRef(Connector connector)
    {
        try
        {
            var refs = connector.AllRefs;
            if (refs is null) return null;

            foreach (Connector other in refs)
            {
                if (other.Owner.Id == connector.Owner.Id) continue;
                // Skip logical connectors (system-level, not physical).
                if (other.ConnectorType == ConnectorType.Logical) continue;

                var portName = DerivePortName(other);
                return portName is null
                    ? other.Owner.UniqueId
                    : $"{other.Owner.UniqueId}:{portName}";
            }
        }
        catch
        {
            // AllRefs can throw if connector is not connected.
        }
        return null;
    }

    /// <summary>
    /// Pick a stable port name for a Revit connector. Prefers Description;
    /// falls back to "c{index}" using the connector's position in its owner's
    /// ConnectorManager. Returns null when the connector belongs to a passive
    /// fitting (MEPCurve endpoint or unnamed passive fitting) where bare
    /// host id is the right reference.
    /// </summary>
    static string? DerivePortName(Connector connector)
    {
        // MEPCurve endpoints don't get port names — pipes/ducts reference their
        // host with bare uid; the connection back into a fitting/equipment
        // carries the named port.
        if (connector.Owner is MEPCurve) return null;

        // Passive fittings (elbow/tee/cross/coupling/cap/transition) leave kind
        // empty and reference bare host id. Active accessories carry port names.
        if (connector.Owner is FamilyInstance fi && IsPassiveFitting(fi))
            return null;

        var desc = connector.Description;
        if (!string.IsNullOrWhiteSpace(desc)) return Slugify(desc!);

        // Fall back to ConnectorManager index.
        var owner = connector.Owner;
        ConnectorSet? siblings = owner is FamilyInstance fi2
            ? fi2.MEPModel?.ConnectorManager?.Connectors
            : owner is MEPCurve mc ? mc.ConnectorManager?.Connectors : null;
        if (siblings is null) return null;
        int idx = 0;
        foreach (Connector c in siblings)
        {
            if (c.Id == connector.Id) return $"c{idx}";
            idx++;
        }
        return $"c{idx}";
    }

    static bool IsPassiveFitting(FamilyInstance fi)
    {
        // Passive fittings live in the *Fitting categories. Accessories
        // (valve/damper/strainer) live in *Accessory categories and carry
        // explicit port names.
        var cat = fi.Category?.BuiltInCategory;
        return cat == BuiltInCategory.OST_PipeFitting
            || cat == BuiltInCategory.OST_DuctFitting
            || cat == BuiltInCategory.OST_CableTrayFitting
            || cat == BuiltInCategory.OST_ConduitFitting;
    }

    static string Slugify(string s)
    {
        var lower = s.Trim().ToLowerInvariant();
        var chars = new char[lower.Length];
        for (var i = 0; i < lower.Length; i++)
        {
            var ch = lower[i];
            chars[i] = char.IsLetterOrDigit(ch) ? ch : '_';
        }
        return new string(chars);
    }
}
