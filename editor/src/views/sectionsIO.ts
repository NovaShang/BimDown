import type { CsvRow } from '../types.ts';
import type { SectionDef } from './viewTypes.ts';

export const VIEW_CSV_PATH = 'global/view.csv';
const HEADER = 'id,name,view_type,start_x,start_y,end_x,end_y,depth';

/** Section rows of global/view.csv → SectionDefs (other view types and broken rows skipped). */
export function sectionsFromRows(rows: CsvRow[]): SectionDef[] {
  const out: SectionDef[] = [];
  for (const r of rows) {
    if (!r.id || (r.view_type || 'section') !== 'section') continue;
    const n = [r.start_x, r.start_y, r.end_x, r.end_y].map(v => parseFloat(v));
    if (n.some(v => !Number.isFinite(v))) continue;
    const depth = parseFloat(r.depth);
    out.push({
      id: r.id,
      name: r.name || '',
      start: { x: n[0], y: n[1] },
      end: { x: n[2], y: n[3] },
      depth: Number.isFinite(depth) && depth > 0 ? depth : undefined,
    });
  }
  return out;
}

const num = (v: number) => String(Math.round(v * 1e6) / 1e6);
function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function sectionsToCsv(sections: SectionDef[]): string {
  const rows = sections.map(s => [
    s.id, csvEscape(s.name), 'section',
    num(s.start.x), num(s.start.y), num(s.end.x), num(s.end.y),
    s.depth != null ? num(s.depth) : '',
  ].join(','));
  return [HEADER, ...rows].join('\n') + '\n';
}

/** Next free `vw-N` id. */
export function nextSectionId(sections: SectionDef[]): string {
  const used = new Set(sections.map(s => s.id));
  let n = 1;
  while (used.has(`vw-${n}`)) n++;
  return `vw-${n}`;
}

/** Default label for a new section: the next unused letter (A, B, …, Z, AA…). */
export function nextSectionName(sections: SectionDef[]): string {
  const used = new Set(sections.map(s => s.name));
  for (let i = 0; i < 702; i++) {
    const name = i < 26 ? String.fromCharCode(65 + i)
      : String.fromCharCode(64 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26));
    if (!used.has(name)) return name;
  }
  return String(sections.length + 1);
}
