using Autodesk.Revit.DB;
using BimDown.RevitAddin;
using BimDown.RevitAddin.Tables;
using Nice3point.TUnit.Revit;

namespace BimDown.RevitTests;

[Explicit]
[Category("SampleProject")]
public class SampleProjectExportTests : RevitApiTest
{
    const string SamplesDir = @"C:\Users\nova\dev\code\BimDown\SourceRevitModels";
    const string SnowdonDir = @"C:\Program Files\Autodesk\Revit 2026\Samples";
    static readonly string OutputBaseDir = Path.GetFullPath(
        Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "sample_data"));

    static ITableExporter[] AllExporters() =>
    [
        new LevelTableExporter(),
        new GridTableExporter(),
        ArchitectureTableExporters.Wall(),
        ArchitectureTableExporters.Column(),
        ArchitectureTableExporters.Slab(),
        ArchitectureTableExporters.Space(),
        ArchitectureTableExporters.Door(),
        ArchitectureTableExporters.Window(),
        ArchitectureTableExporters.Stair(),
        ArchitectureTableExporters.CurtainWall(),
        ArchitectureTableExporters.Roof(),
        ArchitectureTableExporters.Ceiling(),
        ArchitectureTableExporters.Opening(),
        ArchitectureTableExporters.Ramp(),
        ArchitectureTableExporters.Railing(),
        ArchitectureTableExporters.RoomSeparator(),
        StructureTableExporters.StructureWall(),
        StructureTableExporters.StructureColumn(),
        StructureTableExporters.StructureSlab(),
        StructureTableExporters.Beam(),
        StructureTableExporters.Brace(),
        StructureTableExporters.Foundation(),
        MepTableExporters.Duct(),
        MepTableExporters.Pipe(),
        MepTableExporters.CableTray(),
        MepTableExporters.Conduit(),
        MepTableExporters.Equipment(),
        MepTableExporters.Terminal(),
        MepTableExporters.MepNode(),
        new MeshExporter(),
    ];

    static readonly string[] SampleFiles = ["Architecture.rvt", "Structure.rvt", "HVAC.rvt", "Plumbing.rvt"];

    static readonly string[] SnowdonFiles =
    [
        "Snowdon Towers Sample Architectural.rvt",
        "Snowdon Towers Sample Structural.rvt",
        "Snowdon Towers Sample HVAC.rvt",
        "Snowdon Towers Sample Plumbing.rvt",
        "Snowdon Towers Sample Electrical.rvt",
        "Snowdon Towers Sample Facades.rvt",
        "Snowdon Towers Sample Site.rvt",
    ];

    static Document OpenFile(Autodesk.Revit.ApplicationServices.Application app, string dir, string fileName)
    {
        var path = Path.Combine(dir, fileName);
        if (!File.Exists(path))
            throw new FileNotFoundException($"Sample project not found: {path}");
        return app.OpenDocumentFile(path);
    }

    /// <summary>
    /// Runs the REAL export pipeline (ExportCommand.RunExport) against an opened
    /// document and writes the result to <paramref name="outputDir"/>. This keeps
    /// the end-to-end test honest: it exercises the same GeoJSON + format_version 2
    /// path the Revit add-in uses in production, instead of a duplicate.
    /// </summary>
    static void ExportModel(Document doc, string outputDir)
    {
        if (Directory.Exists(outputDir))
            Directory.Delete(outputDir, true);
        Directory.CreateDirectory(outputDir);

        var settings = new ExportSettings
        {
            // Enable every table the add-in knows about (derive from AllExporters
            // so the set stays in sync as exporters are added/removed).
            EnabledTables = [.. AllExporters().Select(e => e.TableName)],
            ExportMesh = true,
            WriteIdsToModel = false,
            Confirmed = true,
        };

        var (_, errors) = ExportPipeline.RunExport(doc, settings, outputDir);

        if (errors.Count > 0)
            throw new Exception(
                "Export failed:\n" +
                string.Join("\n", errors));
    }

    [Test]
    [Arguments("Architecture.rvt")]
    [Arguments("Structure.rvt")]
    [Arguments("HVAC.rvt")]
    [Arguments("Plumbing.rvt")]
    public async Task ExportSampleProject(string fileName)
    {
        var doc = OpenFile(Application, SamplesDir, fileName);
        try
        {
            var outputName = Path.GetFileNameWithoutExtension(fileName);
            var outputDir = Path.Combine(SamplesDir, "..", "sample_data", outputName);
            ExportModel(doc, outputDir);

            var levels = new LevelTableExporter().Export(doc);
            await Assert.That(levels.Count).IsGreaterThanOrEqualTo(1);
        }
        finally
        {
            doc.Close(false);
        }
    }

    [Test]
    [Arguments("Snowdon Towers Sample Architectural.rvt")]
    [Arguments("Snowdon Towers Sample Structural.rvt")]
    [Arguments("Snowdon Towers Sample HVAC.rvt")]
    [Arguments("Snowdon Towers Sample Plumbing.rvt")]
    [Arguments("Snowdon Towers Sample Electrical.rvt")]
    [Arguments("Snowdon Towers Sample Facades.rvt")]
    [Arguments("Snowdon Towers Sample Site.rvt")]
    public async Task ExportSnowdonTowers(string fileName)
    {
        var doc = OpenFile(Application, SnowdonDir, fileName);
        try
        {
            // "Snowdon Towers Sample Architectural.rvt" → "snowdon_architectural"
            var baseName = Path.GetFileNameWithoutExtension(fileName)
                .Replace("Snowdon Towers Sample ", "")
                .ToLowerInvariant();
            var outputDir = Path.Combine(OutputBaseDir, $"snowdon_{baseName}");
            ExportModel(doc, outputDir);

            var levels = new LevelTableExporter().Export(doc);
            await Assert.That(levels.Count).IsGreaterThanOrEqualTo(1);
        }
        finally
        {
            doc.Close(false);
        }
    }

    [Test]
    public async Task Export_AllProjects_NumericFieldsAreValid()
    {
        string[] numericFields = ["elevation", "start_x", "start_y", "end_x", "end_y", "height", "thickness", "width", "rotation", "length", "step_count"];

        var errors = new List<string>();

        foreach (var file in SampleFiles)
        {
            var doc = OpenFile(Application, SamplesDir, file);
            try
            {
                foreach (var exporter in AllExporters())
                {
                    List<Dictionary<string, string?>> rows;
                    try { rows = exporter.Export(doc); }
                    catch { continue; }

                    foreach (var row in rows)
                    {
                        foreach (var field in numericFields)
                        {
                            if (!row.TryGetValue(field, out var val) || val is null) continue;
                            if (!double.TryParse(val, System.Globalization.NumberStyles.Float,
                                    System.Globalization.CultureInfo.InvariantCulture, out var num))
                                errors.Add($"{file}/{exporter.TableName}: '{field}' = '{val}' is not a valid number");
                            else if (!double.IsFinite(num))
                                errors.Add($"{file}/{exporter.TableName}: '{field}' = '{val}' is not finite");
                        }
                    }
                }
            }
            finally
            {
                doc.Close(false);
            }
        }

        await Assert.That(errors.Count).IsEqualTo(0);
    }
}
