using Autodesk.Revit.DB;
using BimDown.RevitAddin;
using BimDown.RevitAddin.Import;
using BimDown.RevitAddin.Tables;
using Nice3point.TUnit.Revit;

namespace BimDown.RevitTests;

public class MepExtendedTests : RevitApiTest
{
    static Level GetFirstLevel(Document doc) =>
        new FilteredElementCollector(doc)
            .OfCategory(BuiltInCategory.OST_Levels)
            .WhereElementIsNotElementType()
            .Cast<Level>()
            .First();

    // ── Cable Tray ────────────────────────────────────────────────

    [Test]
    public async Task Import_CableTray_CreateAndVerify()
    {
        var doc = RevitTestHelper.CreateTempDocument(Application);
        try
        {
            var level = GetFirstLevel(doc);
            var importer = new CableTrayImporter();
            var idMap = RevitTestHelper.BuildIdMap(doc);
            importer.SetIdMap(idMap);

            var csvRows = new List<Dictionary<string, string?>>
            {
                new()
                {
                    ["id"] = "test-ct-001",
                    ["number"] = "CT-1",
                    ["level_id"] = BimDownParameter.Get(level)!,
                    ["start_x"] = "0",
                    ["start_y"] = "0",
                    ["start_z"] = "3",
                    ["end_x"] = "8",
                    ["end_y"] = "0",
                    ["end_z"] = "3",
                    ["shape"] = "rect",
                    ["size_x"] = "0.3",
                    ["size_y"] = "0.1",
                }
            };

            using var tx = new Transaction(doc, "Test Cable Tray Import");
            tx.Start();

            var result = importer.Import(doc, csvRows);
            await Assert.That(result.Created).IsEqualTo(1);
            await Assert.That(result.Errors.Count).IsEqualTo(0);

            var ctId = idMap.Resolve(doc, "test-ct-001");
            await Assert.That(ctId).IsNotNull();

            var ct = doc.GetElement(ctId!);
            await Assert.That(ct).IsNotNull();

            var lc = ct!.Location as LocationCurve;
            await Assert.That(lc).IsNotNull();
            var start = lc!.Curve.GetEndPoint(0);
            var end = lc.Curve.GetEndPoint(1);

            RevitTestHelper.AssertClose(UnitConverter.LengthToFeet(0), start.X, 1e-3, "start_x");
            RevitTestHelper.AssertClose(UnitConverter.LengthToFeet(3), start.Z, 1e-3, "start_z");
            RevitTestHelper.AssertClose(UnitConverter.LengthToFeet(8), end.X, 1e-3, "end_x");

            tx.RollBack();
        }
        finally
        {
            doc.Close(false);
        }
    }

    // ── Conduit ───────────────────────────────────────────────────

    [Test]
    public async Task Import_Conduit_CreateAndVerify()
    {
        var doc = RevitTestHelper.CreateTempDocument(Application);
        try
        {
            var level = GetFirstLevel(doc);
            var importer = new ConduitImporter();
            var idMap = RevitTestHelper.BuildIdMap(doc);
            importer.SetIdMap(idMap);

            var csvRows = new List<Dictionary<string, string?>>
            {
                new()
                {
                    ["id"] = "test-conduit-001",
                    ["number"] = "CO-1",
                    ["level_id"] = BimDownParameter.Get(level)!,
                    ["start_x"] = "0",
                    ["start_y"] = "2",
                    ["start_z"] = "3",
                    ["end_x"] = "6",
                    ["end_y"] = "2",
                    ["end_z"] = "3",
                    ["shape"] = "round",
                    ["size_x"] = "0.025",
                }
            };

            using var tx = new Transaction(doc, "Test Conduit Import");
            tx.Start();

            var result = importer.Import(doc, csvRows);
            await Assert.That(result.Created).IsEqualTo(1);
            await Assert.That(result.Errors.Count).IsEqualTo(0);

            var conduitId = idMap.Resolve(doc, "test-conduit-001");
            await Assert.That(conduitId).IsNotNull();

            var conduit = doc.GetElement(conduitId!);
            await Assert.That(conduit).IsNotNull();

            var lc = conduit!.Location as LocationCurve;
            await Assert.That(lc).IsNotNull();

            tx.RollBack();
        }
        finally
        {
            doc.Close(false);
        }
    }

    // ── Equipment ─────────────────────────────────────────────────

    [Test]
    public async Task Import_Equipment_CreateAndVerify()
    {
        var doc = RevitTestHelper.CreateTempDocument(Application);
        try
        {
            var level = GetFirstLevel(doc);

            // Check if equipment families exist in template
            var hasSymbol = new FilteredElementCollector(doc)
                .OfCategory(BuiltInCategory.OST_MechanicalEquipment)
                .OfClass(typeof(FamilySymbol))
                .Any()
                || new FilteredElementCollector(doc)
                    .OfCategory(BuiltInCategory.OST_ElectricalEquipment)
                    .OfClass(typeof(FamilySymbol))
                    .Any();

            if (!hasSymbol)
            {
                // No equipment families in template — skip
                return;
            }

            var importer = new EquipmentImporter();
            var idMap = RevitTestHelper.BuildIdMap(doc);
            importer.SetIdMap(idMap);

            var csvRows = new List<Dictionary<string, string?>>
            {
                new()
                {
                    ["id"] = "test-equip-001",
                    ["number"] = "EQ-1",
                    ["level_id"] = BimDownParameter.Get(level)!,
                    ["x"] = "5",
                    ["y"] = "5",
                    ["rotation"] = "90",
                }
            };

            using var tx = new Transaction(doc, "Test Equipment Import");
            tx.Start();

            var result = importer.Import(doc, csvRows);
            await Assert.That(result.Created).IsEqualTo(1);
            await Assert.That(result.Errors.Count).IsEqualTo(0);

            var equipId = idMap.Resolve(doc, "test-equip-001");
            await Assert.That(equipId).IsNotNull();

            var equip = doc.GetElement(equipId!) as FamilyInstance;
            await Assert.That(equip).IsNotNull();

            tx.RollBack();
        }
        finally
        {
            doc.Close(false);
        }
    }

    // ── Terminal ──────────────────────────────────────────────────

    [Test]
    public async Task Import_Terminal_CreateAndVerify()
    {
        var doc = RevitTestHelper.CreateTempDocument(Application);
        try
        {
            var level = GetFirstLevel(doc);

            // Check if terminal families exist
            var terminalCategories = new[]
            {
                BuiltInCategory.OST_DuctTerminal,
                BuiltInCategory.OST_Sprinklers,
                BuiltInCategory.OST_LightingFixtures,
                BuiltInCategory.OST_ElectricalFixtures,
            };

            var hasSymbol = terminalCategories.Any(cat =>
                new FilteredElementCollector(doc)
                    .OfCategory(cat)
                    .OfClass(typeof(FamilySymbol))
                    .Any());

            if (!hasSymbol)
            {
                return;
            }

            var importer = new TerminalImporter();
            var idMap = RevitTestHelper.BuildIdMap(doc);
            importer.SetIdMap(idMap);

            var csvRows = new List<Dictionary<string, string?>>
            {
                new()
                {
                    ["id"] = "test-term-001",
                    ["number"] = "T-1",
                    ["level_id"] = BimDownParameter.Get(level)!,
                    ["x"] = "3",
                    ["y"] = "4",
                    ["rotation"] = "0",
                }
            };

            using var tx = new Transaction(doc, "Test Terminal Import");
            tx.Start();

            var result = importer.Import(doc, csvRows);
            await Assert.That(result.Created).IsEqualTo(1);
            await Assert.That(result.Errors.Count).IsEqualTo(0);

            var termId = idMap.Resolve(doc, "test-term-001");
            await Assert.That(termId).IsNotNull();

            var terminal = doc.GetElement(termId!) as FamilyInstance;
            await Assert.That(terminal).IsNotNull();

            tx.RollBack();
        }
        finally
        {
            doc.Close(false);
        }
    }

    // ── Exporter Field Verification ─────────────────────────────

    [Test]
    public async Task CableTray_Exporter_HasPortRefFields()
    {
        // cable_tray is a connectable MEP curve (inherits mep_connectable in spec;
        // editor treats it as a MEP line table and wires from/to). It carries port refs.
        var exporter = MepTableExporters.CableTray();
        await Assert.That(exporter.Columns.Contains("from")).IsTrue();
        await Assert.That(exporter.Columns.Contains("to")).IsTrue();
        await Assert.That(exporter.CsvColumns.Contains("from")).IsTrue();
    }

    [Test]
    public async Task Conduit_Exporter_HasPortRefFields()
    {
        var exporter = MepTableExporters.Conduit();
        await Assert.That(exporter.Columns.Contains("from")).IsTrue();
        await Assert.That(exporter.Columns.Contains("to")).IsTrue();
    }

    [Test]
    public async Task Duct_Exporter_HasPortRefFields()
    {
        var exporter = MepTableExporters.Duct();
        await Assert.That(exporter.Columns.Contains("from")).IsTrue();
        await Assert.That(exporter.Columns.Contains("to")).IsTrue();
    }

    // ── MEP Round-trip Export Tests ────────────────────────────────

    [Test]
    public async Task RoundTrip_CableTray_ExportThenCsv()
    {
        var doc = RevitTestHelper.CreateTempDocument(Application);
        try
        {
            var exporter = MepTableExporters.CableTray();
            var exportedRows = exporter.Export(doc);

            // Verify exporter runs; template may have no cable trays
            if (exportedRows.Count > 0)
            {
                var (_, csvRows) = RevitTestHelper.RoundTripCsv(exporter.Columns, exportedRows);
                await Assert.That(csvRows.Count).IsEqualTo(exportedRows.Count);
            }
        }
        finally
        {
            doc.Close(false);
        }
    }

    [Test]
    public async Task RoundTrip_Conduit_ExportThenCsv()
    {
        var doc = RevitTestHelper.CreateTempDocument(Application);
        try
        {
            var exporter = MepTableExporters.Conduit();
            var exportedRows = exporter.Export(doc);

            if (exportedRows.Count > 0)
            {
                var (_, csvRows) = RevitTestHelper.RoundTripCsv(exporter.Columns, exportedRows);
                await Assert.That(csvRows.Count).IsEqualTo(exportedRows.Count);
            }
        }
        finally
        {
            doc.Close(false);
        }
    }

    [Test]
    public async Task RoundTrip_Equipment_ExportThenCsv()
    {
        var doc = RevitTestHelper.CreateTempDocument(Application);
        try
        {
            var exporter = MepTableExporters.Equipment();
            var exportedRows = exporter.Export(doc);

            if (exportedRows.Count > 0)
            {
                var (_, csvRows) = RevitTestHelper.RoundTripCsv(exporter.Columns, exportedRows);
                await Assert.That(csvRows.Count).IsEqualTo(exportedRows.Count);
            }
        }
        finally
        {
            doc.Close(false);
        }
    }

    [Test]
    public async Task RoundTrip_Terminal_ExportThenCsv()
    {
        var doc = RevitTestHelper.CreateTempDocument(Application);
        try
        {
            var exporter = MepTableExporters.Terminal();
            var exportedRows = exporter.Export(doc);

            if (exportedRows.Count > 0)
            {
                var (_, csvRows) = RevitTestHelper.RoundTripCsv(exporter.Columns, exportedRows);
                await Assert.That(csvRows.Count).IsEqualTo(exportedRows.Count);
            }
        }
        finally
        {
            doc.Close(false);
        }
    }
}
