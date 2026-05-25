using System.IO.Compression;
using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace BimDown.RevitAddin;

[Transaction(TransactionMode.Manual)]
public class ExportCommand : IExternalCommand
{
    public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
    {
        var doc = commandData.Application.ActiveUIDocument.Document;

        using var settingsForm = new ExportSettingsForm();
        settingsForm.ShowDialog();

        if (!settingsForm.Result.Confirmed)
            return Result.Cancelled;

        var settings = settingsForm.Result;
        var tempDir = Path.Combine(Path.GetTempPath(), $"bimdown-export-{Guid.NewGuid():N}");

        try
        {
            Directory.CreateDirectory(tempDir);
            var (tableCount, errors) = ExportPipeline.RunExport(doc, settings, tempDir);

            // Pack to .bimdown zip
            if (File.Exists(settings.OutputFile))
                File.Delete(settings.OutputFile);
            ZipFile.CreateFromDirectory(tempDir, settings.OutputFile);

            var msg = $"Exported {tableCount} tables to:\n{settings.OutputFile}";
            if (errors.Count > 0)
                msg += $"\n\nWarnings ({errors.Count}):\n" + string.Join("\n", errors);

            Autodesk.Revit.UI.TaskDialog.Show("BimDown Export", msg);
        }
        finally
        {
            try { Directory.Delete(tempDir, true); } catch { }
        }

        return Result.Succeeded;
    }
}
