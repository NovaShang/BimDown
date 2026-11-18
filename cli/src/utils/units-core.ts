/** Project units without file access (shared with the browser IFC importer). */

/** Project units → meters. Values are stored in the unit declared in project_metadata.json (default m). */
export const UNIT_TO_M: Record<string, number> = { m: 1, ft: 0.3048, in: 0.0254, mm: 0.001 };

/** The units declared in project_metadata.json text ("m" when missing or invalid). */
export function unitsOfMetadata(text: string | undefined): string {
  try {
    const u = text ? JSON.parse(text).units : undefined;
    if (typeof u === 'string' && u in UNIT_TO_M) return u;
  } catch { /* invalid metadata */ }
  return 'm';
}
