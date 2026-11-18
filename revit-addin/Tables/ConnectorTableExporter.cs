using Autodesk.Revit.DB;
using BimDown.RevitAddin;

namespace BimDown.RevitAddin.Tables;

/// <summary>
/// Exports a connector.csv row for every port on equipment, terminal, and
/// active MEP accessories (valve/damper/strainer/etc). Passive fittings
/// (elbow/tee/cross/coupling/cap/transition) do NOT get connector rows —
/// their ports are derived from connected-pipe geometry at runtime. MEP
/// curves (pipe/duct/conduit/cable_tray) also don't get connector rows —
/// their endpoints are implicit.
///
/// Row schema:
///   id, host_id, name, offset_x/y/z, dir_x/y/z, shape, size_w, size_h,
///   system_type, flow_dir, domain
///
/// Coordinates are in the host's local frame:
///   offset = R(-host.rotation_z) · (connector.Origin - host.Origin)
///   dir    = R(-host.rotation_z) · (-connector.CoordinateSystem.BasisZ)
/// (Revit's Connector.CoordinateSystem.BasisZ points INTO the family;
/// outward direction is the negated Z basis.)
/// </summary>
public class ConnectorTableExporter : ITableExporter
{
    // Every equipment / terminal category the instance tables export (plumbing fixtures,
    // devices, …) plus active accessories (mep_node with explicit kind): a curve's
    // "host:port" reference needs its port row.
    static readonly BuiltInCategory[] HostCategories =
    [
        .. MepTableExporters.DeviceCategories,
        BuiltInCategory.OST_PipeAccessory,
        BuiltInCategory.OST_DuctAccessory,
    ];

    static readonly string[] AllColumns =
    [
        "id", "host_id", "name",
        "offset_x", "offset_y", "offset_z",
        "dir_x", "dir_y", "dir_z",
        "shape", "size_w", "size_h",
        "system_type", "flow_dir", "domain",
    ];

    public string TableName => "connector";
    public IReadOnlyList<string> Columns => AllColumns;
    public IReadOnlyList<string> CsvColumns => AllColumns;

    public List<Dictionary<string, string?>> Export(Document doc)
    {
        var rows = new List<Dictionary<string, string?>>();

        foreach (var category in HostCategories)
        {
            var collector = new FilteredElementCollector(doc)
                .OfCategory(category)
                .WhereElementIsNotElementType();

            foreach (var element in collector.OrderBy(e => e.Id.Value))
            {
                if (element is not FamilyInstance fi) continue;
                var connectors = fi.MEPModel?.ConnectorManager?.Connectors;
                if (connectors is null) continue;

                var hostId = fi.UniqueId;
                var hostLevel = fi.LevelId != ElementId.InvalidElementId ? doc.GetElement(fi.LevelId)?.UniqueId : null;
                var hostOrigin = (fi.Location as LocationPoint)?.Point ?? XYZ.Zero;
                var hostRotation = (fi.Location as LocationPoint)?.Rotation ?? 0;
                var cosNeg = Math.Cos(-hostRotation);
                var sinNeg = Math.Sin(-hostRotation);

                var index = 0;
                foreach (Connector conn in connectors)
                {
                    try
                    {
                        var name = DerivePortName(conn, index);

                        var worldOffset = conn.Origin - hostOrigin;
                        var localOffsetX = worldOffset.X * cosNeg - worldOffset.Y * sinNeg;
                        var localOffsetY = worldOffset.X * sinNeg + worldOffset.Y * cosNeg;
                        var localOffsetZ = worldOffset.Z;

                        // Outward direction = -BasisZ of the connector's CoordinateSystem.
                        // CoordinateSystem may be unset on logical connectors; guard.
                        XYZ worldDir;
                        try { worldDir = -conn.CoordinateSystem.BasisZ; }
                        catch { worldDir = XYZ.Zero; }
                        var localDirX = worldDir.X * cosNeg - worldDir.Y * sinNeg;
                        var localDirY = worldDir.X * sinNeg + worldDir.Y * cosNeg;
                        var localDirZ = worldDir.Z;

                        var row = new Dictionary<string, string?>
                        {
                            ["id"] = $"{hostId}.c{index}",
                            ["host_id"] = hostId,
                            ["name"] = name,
                            ["offset_x"] = FormatMeters(localOffsetX),
                            ["offset_y"] = FormatMeters(localOffsetY),
                            ["offset_z"] = FormatMeters(localOffsetZ),
                            ["dir_x"] = UnitConverter.FormatDouble(localDirX),
                            ["dir_y"] = UnitConverter.FormatDouble(localDirY),
                            ["dir_z"] = UnitConverter.FormatDouble(localDirZ),
                            ["shape"] = DeriveShape(conn),
                            ["size_w"] = DeriveSizeW(conn),
                            ["size_h"] = DeriveSizeH(conn),
                            ["system_type"] = DeriveSystemType(conn),
                            ["flow_dir"] = DeriveFlowDir(conn),
                            ["domain"] = DeriveDomain(conn),
                            // Partition with the host (the connector lives in its host's directory).
                            ["level_id"] = hostLevel,
                            ["top_level_id"] = null,
                        };
                        rows.Add(row);
                    }
                    catch
                    {
                        // Skip connectors that fail extraction (e.g. logical-only).
                    }
                    index++;
                }
            }
        }

        return rows;
    }

    static string DerivePortName(Connector conn, int index)
    {
        var desc = conn.Description;
        if (!string.IsNullOrWhiteSpace(desc)) return Slugify(desc!);
        return $"c{index}";
    }

    static string? DeriveShape(Connector conn) => conn.Shape switch
    {
        ConnectorProfileType.Round => "round",
        ConnectorProfileType.Rectangular => "rect",
        ConnectorProfileType.Oval => "round", // closest-fit; spec doesn't have oval
        _ => null,
    };

    static string? DeriveSizeW(Connector conn)
    {
        try
        {
            return conn.Shape switch
            {
                ConnectorProfileType.Round => FormatMeters(conn.Radius * 2.0),
                ConnectorProfileType.Rectangular => FormatMeters(conn.Width),
                ConnectorProfileType.Oval => FormatMeters(conn.Radius * 2.0),
                _ => null,
            };
        }
        catch { return null; }
    }

    static string? DeriveSizeH(Connector conn)
    {
        try
        {
            return conn.Shape == ConnectorProfileType.Rectangular
                ? FormatMeters(conn.Height)
                : null;
        }
        catch { return null; }
    }

    static string? DeriveSystemType(Connector conn)
    {
        try { return Extractors.MepSystemExtractor.FromSystem(conn.Owner.Document, conn.MEPSystem); }
        catch { return null; }
    }

    // Direction / Domain throw on some connector kinds: a missing value, not a missing port.
    static string? DeriveFlowDir(Connector conn)
    {
        try
        {
            return conn.Direction switch
            {
                FlowDirectionType.In => "in",
                FlowDirectionType.Out => "out",
                FlowDirectionType.Bidirectional => "bidirectional",
                _ => null,
            };
        }
        catch { return null; }
    }

    static string? DeriveDomain(Connector conn)
    {
        try
        {
            return conn.Domain switch
            {
                Domain.DomainHvac => "hvac",
                Domain.DomainPiping => "piping",
                Domain.DomainElectrical => "electrical",
                Domain.DomainCableTrayConduit => "cable_tray_conduit",
                _ => null,
            };
        }
        catch { return null; }
    }

    static string FormatMeters(double feet) =>
        UnitConverter.FormatDouble(UnitConverter.Length(feet));

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
