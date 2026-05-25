using System.IO.Compression;
using System.Net.Http;
using System.Text.Json;
using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace BimDown.RevitAddin;

[Transaction(TransactionMode.Manual)]
public class ShareCommand : IExternalCommand
{
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(5) };

    public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
    {
        var doc = commandData.Application.ActiveUIDocument.Document;
        var projectName = doc.Title ?? "Untitled";

        var tempDir = Path.Combine(Path.GetTempPath(), "bimdown-share");

        try
        {
            // Clean previous temp dir
            if (Directory.Exists(tempDir))
                Directory.Delete(tempDir, true);
            Directory.CreateDirectory(tempDir);

            // Export on main thread (Revit API requirement)
            var settings = CreateShareSettings();
            var (tableCount, errors) = ExportPipeline.RunExport(doc, settings, tempDir);

            if (tableCount == 0)
            {
                Autodesk.Revit.UI.TaskDialog.Show(L.ShareProgressTitle,
                    L.ShareFailed("No tables exported"));
                return Result.Failed;
            }

            // Zip + upload off main thread, show waiting dialog
            var zipPath = tempDir + ".zip";
            if (File.Exists(zipPath))
                File.Delete(zipPath);

            string? shareUrl = null;
            string? expiresAt = null;
            string? uploadError = null;

            using var progressForm = new ShareProgressForm();
            progressForm.Shown += async (_, _) =>
            {
                try
                {
                    progressForm.SetStatus(L.SharePacking);
                    await Task.Run(() => ZipFile.CreateFromDirectory(tempDir, zipPath));

                    progressForm.SetStatus(L.ShareUploading);
                    var result = await Task.Run(() => Upload(zipPath, projectName));

                    shareUrl = result.Url;
                    expiresAt = result.ExpiresAt;
                }
                catch (Exception ex)
                {
                    uploadError = ex.Message;
                }
                finally
                {
                    try { progressForm.Invoke(progressForm.Close); } catch { }
                }
            };
            progressForm.ShowDialog();

            // Show result
            if (uploadError is not null)
            {
                Autodesk.Revit.UI.TaskDialog.Show(L.ShareProgressTitle, L.ShareFailed(uploadError));
            }
            else if (shareUrl is not null)
            {
                using var resultForm = new ShareResultForm(shareUrl, expiresAt ?? "");
                resultForm.ShowDialog();
            }

            return Result.Succeeded;
        }
        finally
        {
            // Cleanup temp files
            try
            {
                if (Directory.Exists(tempDir))
                    Directory.Delete(tempDir, true);
                var zipPath = tempDir + ".zip";
                if (File.Exists(zipPath))
                    File.Delete(zipPath);
            }
            catch { }
        }
    }

    static ExportSettings CreateShareSettings() => new()
    {
        OutputFile = "",
        ExportMesh = UserSettings.GetBool("ExportMesh", true),
        WriteIdsToModel = false,
        Confirmed = true,
        EnabledTables =
        [
            "level", "grid",
            "wall", "column", "slab", "space", "door", "window", "stair",
            "curtain_wall", "roof", "ceiling", "opening", "ramp", "railing", "room_separator",
            "structure_wall", "structure_column", "structure_slab", "beam", "brace", "foundation",
            "duct", "pipe", "cable_tray", "conduit", "mep_node", "equipment", "terminal",
        ],
    };

    static (string Url, string ExpiresAt) Upload(string zipPath, string projectName)
    {
        var apiBase = UserSettings.ShareApiBase.TrimEnd('/');
        var expires = UserSettings.ShareExpires;

        using var content = new MultipartFormDataContent();

        var fileContent = new ByteArrayContent(File.ReadAllBytes(zipPath));
        fileContent.Headers.ContentType = new("application/zip");
        fileContent.Headers.ContentDisposition =
            new("form-data") { Name = "\"file\"", FileName = "\"project.zip\"" };
        content.Add(fileContent);

        var nameContent = new StringContent(projectName);
        nameContent.Headers.ContentDisposition = new("form-data") { Name = "\"name\"" };
        content.Add(nameContent);

        var expiresContent = new StringContent(expires);
        expiresContent.Headers.ContentDisposition = new("form-data") { Name = "\"expires\"" };
        content.Add(expiresContent);

        var response = Http.PostAsync($"{apiBase}/api/shares/publish", content)
            .GetAwaiter().GetResult();

        var body = response.Content.ReadAsStringAsync().GetAwaiter().GetResult();

        if (!response.IsSuccessStatusCode)
        {
            var errorMsg = body;
            try
            {
                var errorJson = JsonSerializer.Deserialize<JsonElement>(body);
                if (errorJson.TryGetProperty("error", out var errorProp))
                    errorMsg = errorProp.GetString() ?? body;
            }
            catch { }
            throw new Exception($"HTTP {(int)response.StatusCode}: {errorMsg}");
        }

        var json = JsonSerializer.Deserialize<JsonElement>(body);
        var url = json.GetProperty("url").GetString()
            ?? throw new Exception("Missing 'url' in response");
        var expiresAt = json.GetProperty("expiresAt").GetString() ?? "";

        return (url, expiresAt);
    }
}
