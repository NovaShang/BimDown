using System.IO;
using System.Text;

namespace BimDown.RevitAddin;

static class CsvWriter
{
    public static void Write(string filePath, IReadOnlyList<string> columns, List<Dictionary<string, string?>> rows)
    {
        using var writer = new StreamWriter(filePath, false, new UTF8Encoding(true));

        // Header
        writer.WriteLine(string.Join(",", columns));

        // Rows
        foreach (var row in rows)
        {
            var values = new string[columns.Count];
            for (var i = 0; i < columns.Count; i++)
            {
                var col = columns[i];
                values[i] = row.TryGetValue(col, out var val) && val is not null
                    ? EscapeCsvField(val)
                    : "";
            }
            writer.WriteLine(string.Join(",", values));
        }
    }

    static string EscapeCsvField(string field)
    {
        // One record per line: multi-line Revit text (type comments, descriptions) is flattened.
        if (field.Contains('\n') || field.Contains('\r'))
            field = string.Join(" ", field.Split(["\r\n", "\n", "\r"], StringSplitOptions.None).Select(p => p.Trim()).Where(p => p.Length > 0));
        if (field.Contains(',') || field.Contains('"') || field.Contains('\n') || field.Contains('\r'))
        {
            return "\"" + field.Replace("\"", "\"\"") + "\"";
        }
        return field;
    }
}
