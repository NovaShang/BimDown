using Autodesk.Revit.DB;
using BimDown.RevitAddin;
using BimDown.RevitAddin.Svg;
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

    static void ExportModel(Document doc, string outputDir)
    {
        if (Directory.Exists(outputDir))
            Directory.Delete(outputDir, true);
        Directory.CreateDirectory(outputDir);

        var exporters = AllExporters();
        var idGen = new ShortIdGenerator();
        var errors = new List<string>();

        // Pass 1: export all tables
        var exported = new List<(ITableExporter Exporter, List<Dictionary<string, string?>> Rows)>();
        foreach (var exporter in exporters)
        {
            try
            {
                var rows = exporter.Export(doc);
                if (rows.Count > 0)
                    exported.Add((exporter, rows));
            }
            catch (Exception ex)
            {
                errors.Add($"{exporter.TableName}: {ex.Message}");
            }
        }

        // Pass 2: remap IDs
        foreach (var (exporter, rows) in exported)
        {
            if (exporter.IsGlobal)
                idGen.RemapGlobalRows(exporter.TableName, rows);
            else
                idGen.RemapPartitionedRows(exporter.TableName, rows, _ => "lv-1");

            var (_, rtRows) = RevitTestHelper.RoundTripCsv(exporter.CsvColumns, rows);
            if (rtRows.Count != rows.Count)
                errors.Add($"{exporter.TableName}: CSV round-trip row count mismatch ({rows.Count} -> {rtRows.Count})");
        }

        // Build level index for partitioning
        var levelData = exported.FirstOrDefault(e => e.Exporter.TableName == "level");
        var levelIndex = new Dictionary<string, int>();
        if (levelData.Rows is not null)
        {
            var sorted = levelData.Rows
                .Where(r => r.GetValueOrDefault("id") is not null && r.GetValueOrDefault("elevation") is not null)
                .OrderBy(r => double.Parse(r["elevation"]!, System.Globalization.CultureInfo.InvariantCulture))
                .ToList();
            for (var i = 0; i < sorted.Count; i++)
                levelIndex[sorted[i]["id"]!] = i;
        }

        // Pass 3: export GLB mesh files (before CSV so mesh_file field is populated)
        var meshData = exported.FirstOrDefault(e => e.Exporter is MeshExporter);
        if (meshData.Exporter is MeshExporter meshExporter && meshData.Rows is not null)
        {
            errors.AddRange(meshExporter.ExportGlbFiles(outputDir, meshData.Rows, idGen.Mappings));
        }

        // Write CSVs
        foreach (var (exporter, rows) in exported)
        {
            if (exporter.IsGlobal)
            {
                var globalDir = Path.Combine(outputDir, "global");
                Directory.CreateDirectory(globalDir);
                CsvWriter.Write(Path.Combine(globalDir, $"{exporter.TableName}.csv"), exporter.CsvColumns, rows);
            }
            else
            {
                var levelRows = new Dictionary<string, List<Dictionary<string, string?>>>();

                foreach (var row in rows)
                {
                    var levelId = row.GetValueOrDefault("level_id");
                    var topLevelId = row.GetValueOrDefault("top_level_id");

                    var isMultiStory = false;
                    if (levelId is not null && topLevelId is not null
                        && levelIndex.TryGetValue(levelId, out var baseIdx)
                        && levelIndex.TryGetValue(topLevelId, out var topIdx))
                    {
                        isMultiStory = topIdx - baseIdx > 1;
                    }

                    var dirName = (isMultiStory || levelId is null) ? "global" : levelId;

                    if (!levelRows.TryGetValue(dirName, out var list))
                    {
                        list = [];
                        levelRows[dirName] = list;
                    }
                    list.Add(row);
                }

                foreach (var (dirName, groupRows) in levelRows)
                {
                    var dir = Path.Combine(outputDir, dirName);
                    Directory.CreateDirectory(dir);
                    CsvWriter.Write(Path.Combine(dir, $"{exporter.TableName}.csv"), exporter.CsvColumns, groupRows);
                }
            }
        }

        // Write _IdMap.csv
        var globalFolder = Path.Combine(outputDir, "global");
        Directory.CreateDirectory(globalFolder);
        var idMapRows = idGen.Mappings.Select(kvp => new Dictionary<string, string?>
        {
            ["id"] = kvp.Value,
            ["uuid"] = kvp.Key
        }).ToList();
        CsvWriter.Write(Path.Combine(globalFolder, "_IdMap.csv"), ["id", "uuid"], idMapRows);

        // Write project_metadata.json
        var metadata = new Dictionary<string, string>
        {
            ["format_version"] = "3.0",
            ["project_name"] = doc.Title ?? "",
            ["units"] = "m",
            ["source"] = $"Revit {doc.Application.VersionNumber}"
        };
        var json = System.Text.Json.JsonSerializer.Serialize(metadata,
            new System.Text.Json.JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(Path.Combine(outputDir, "project_metadata.json"), json);

        // Pass 4: write SVG geometry layer
        if (levelData.Rows is not null)
        {
            try
            {
                SvgWriter.WriteAll(outputDir,
                    exported.Select(e => (e.Exporter.TableName, e.Rows)).ToList(),
                    levelData.Rows);
            }
            catch (Exception ex)
            {
                errors.Add($"SVG export: {ex.Message}");
            }
        }

        if (errors.Count > 0)
            throw new Exception(
                $"Export failed:\n" +
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
