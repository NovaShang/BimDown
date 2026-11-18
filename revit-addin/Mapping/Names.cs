using System.Globalization;
using System.Text;

namespace BimDown.RevitAddin.Mapping;

/// <summary>
/// String helpers shared by the Revit → BimDown mappers. Everything in
/// <c>Mapping/</c> is pure (no Revit API) so it runs in the macOS / Linux
/// unit tests (Mapping.Tests).
/// </summary>
public static class Names
{
    /// <summary>True when <paramref name="text"/> contains any keyword (case-insensitive).</summary>
    public static bool ContainsAny(string? text, params string[] keywords)
    {
        if (string.IsNullOrEmpty(text)) return false;
        foreach (var k in keywords)
            if (text.Contains(k, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    /// <summary>
    /// Lower-case ASCII slug for readable ids: "Basic Wall: Generic - 200mm" →
    /// "basic-wall-generic-200mm". Non-ASCII letters (e.g. Chinese type names)
    /// are dropped; an empty result falls back to <paramref name="fallback"/>.
    /// </summary>
    public static string Slug(string? text, string fallback = "type", int maxLength = 40)
    {
        var sb = new StringBuilder();
        var dash = false;
        foreach (var ch in (text ?? "").Normalize(NormalizationForm.FormD))
        {
            if (CharUnicodeInfo.GetUnicodeCategory(ch) == UnicodeCategory.NonSpacingMark) continue;
            if (ch < 128 && char.IsLetterOrDigit(ch))
            {
                sb.Append(char.ToLowerInvariant(ch));
                dash = false;
            }
            else if (sb.Length > 0 && !dash)
            {
                sb.Append('-');
                dash = true;
            }
        }
        var s = sb.ToString().Trim('-');
        if (s.Length > maxLength) s = s[..maxLength].Trim('-');
        return s.Length == 0 ? fallback : s;
    }

    /// <summary>Port-name slug (connector names): lower case, non-alphanumerics → '_'.</summary>
    public static string PortSlug(string s)
    {
        var lower = s.Trim().ToLowerInvariant();
        var chars = new char[lower.Length];
        for (var i = 0; i < lower.Length; i++)
            chars[i] = char.IsLetterOrDigit(lower[i]) ? lower[i] : '_';
        return new string(chars);
    }

    /// <summary>Formats a value rounded to 3 decimals, invariant culture (BimDown CSV numbers).</summary>
    public static string Num(double value) => UnitConverter.FormatDouble(value);

    public static string? Num(double? value) => value is { } v ? UnitConverter.FormatDouble(v) : null;

    /// <summary>Formats a value rounded to <paramref name="decimals"/>, invariant culture.</summary>
    public static string Num(double value, int decimals) =>
        Math.Round(value, decimals).ToString("0.##########", CultureInfo.InvariantCulture);

    public static string? Num(double? value, int decimals) => value is { } v ? Num(v, decimals) : null;

    /// <summary>Parses an invariant-culture number, null when empty or invalid.</summary>
    public static double? Parse(string? s) =>
        !string.IsNullOrWhiteSpace(s) && double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : null;
}
