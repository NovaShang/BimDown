/**
 * MEP sizes: standard size series (rectangular / round duct, DN and plastic
 * de pipe series by material, conduit, cable tray), and mm / DN / inch
 * display. Stored values stay in project units (metres for most projects);
 * these helpers only convert for display and pick lists.
 */
import type { ProjectUnit } from '../types.ts';

/** Rectangular duct sides, mm (50 mm steps to 500, then 100 / 200). */
export const RECT_DUCT_MM = [100, 150, 200, 250, 300, 350, 400, 450, 500, 600, 700, 800, 900, 1000, 1200, 1400, 1600, 1800, 2000];
/** Round spiral duct diameters, mm (EN 1506). */
export const ROUND_DUCT_MM = [80, 100, 125, 160, 200, 250, 315, 355, 400, 450, 500, 560, 630, 710, 800, 900, 1000, 1120, 1250];
/** Nominal pipe sizes DN, mm (steel, stainless, copper, cast / ductile iron). */
export const DN_MM = [15, 20, 25, 32, 40, 50, 65, 80, 100, 125, 150, 200, 250, 300, 350, 400, 450, 500, 600];
/** Plastic pipe outside diameters de, mm (PVC-U, PP-R, HDPE, PEX). */
export const DE_MM = [16, 20, 25, 32, 40, 50, 63, 75, 90, 110, 125, 160, 200, 250, 315, 400];
/** Conduit diameters, mm. */
export const CONDUIT_MM = [16, 20, 25, 32, 40, 50, 63];
/** Cable tray width / height, mm. */
export const TRAY_W_MM = [50, 100, 150, 200, 300, 400, 500, 600, 800, 1000];
export const TRAY_H_MM = [50, 75, 100, 150, 200];

/** NPS (inch) label for each DN, for imperial projects. */
const NPS: Record<number, string> = {
  15: '1/2"', 20: '3/4"', 25: '1"', 32: '1-1/4"', 40: '1-1/2"', 50: '2"', 65: '2-1/2"', 80: '3"', 100: '4"', 125: '5"',
  150: '6"', 200: '8"', 250: '10"', 300: '12"', 350: '14"', 400: '16"', 450: '18"', 500: '20"', 600: '24"',
};

/** Pipe materials (pipe.material) and the series their size is named in. */
export const PIPE_MATERIALS = ['steel', 'galvanized_steel', 'stainless_steel', 'copper', 'cast_iron', 'ductile_iron', 'pvc', 'ppr', 'hdpe', 'pex'] as const;
export type PipeMaterial = typeof PIPE_MATERIALS[number];
const PLASTIC = new Set(['pvc', 'ppr', 'hdpe', 'pex']);

export function isPlasticPipe(material: string | undefined): boolean {
  return PLASTIC.has((material ?? '').trim());
}

export type SizeKey = 'size_x' | 'size_y';

/** Standard sizes (mm) offered for a field of an MEP run. */
export function sizeSeries(table: string, key: SizeKey, shape: string | undefined, material?: string): number[] {
  if (table === 'pipe') return isPlasticPipe(material) ? DE_MM : DN_MM;
  if (table === 'conduit') return CONDUIT_MM;
  if (table === 'cable_tray') return key === 'size_x' ? TRAY_W_MM : TRAY_H_MM;
  if (table === 'duct') return shape === 'round' ? ROUND_DUCT_MM : RECT_DUCT_MM;
  return [];
}

/** Smallest series value ≥ `mm` (the largest when over the range). */
export function upToSeries(mm: number, series: readonly number[]): number {
  for (const s of series) if (s >= mm - 1e-6) return s;
  return series[series.length - 1] ?? mm;
}

/** The series value within 12 % (or 2 mm) of `mm`, if any. */
export function matchSeries(mm: number, series: readonly number[]): number | undefined {
  return series.find(n => Math.abs(n - mm) <= Math.max(2, n * 0.12));
}

/** Unit MEP sizes are shown in: mm for metric projects, inches for imperial ones. */
export function sizeDisplayUnit(unit: ProjectUnit | undefined): 'mm' | 'in' {
  return unit === 'ft' || unit === 'in' ? 'in' : 'mm';
}

const PER_M: Record<ProjectUnit, number> = { m: 1, mm: 1000, ft: 1 / 0.3048, in: 1 / 0.0254 };

/** Project-unit value → metres. */
export function toMetres(v: number, unit: ProjectUnit | undefined = 'm'): number {
  return v / PER_M[unit ?? 'm'];
}

/** Metres → project units. */
export function fromMetres(m: number, unit: ProjectUnit | undefined = 'm'): number {
  return m * PER_M[unit ?? 'm'];
}

/** Stored size (project units) → display number (mm, or inches for imperial). */
export function sizeToDisplay(v: number, unit: ProjectUnit | undefined): number {
  const m = toMetres(v, unit);
  return sizeDisplayUnit(unit) === 'in' ? Math.round((m / 0.0254) * 100) / 100 : Math.round(m * 10000) / 10;
}

/** Display number (mm / in) → stored size (project units), rounded to 0.1 mm. */
export function sizeFromDisplay(d: number, unit: ProjectUnit | undefined): number {
  const m = sizeDisplayUnit(unit) === 'in' ? d * 0.0254 : d / 1000;
  const v = fromMetres(m, unit);
  return unit === 'mm' ? Math.round(v * 10) / 10 : Math.round(v * 1e5) / 1e5;
}

/**
 * Parse a typed size: "65", "DN65", "de110", "Ø200", "200 mm", "4\"", "1-1/2\"".
 * Returns the display-unit number (mm, or inches for imperial), or null.
 */
export function parseSizeText(raw: string, unit: ProjectUnit | undefined): number | null {
  let s = raw.trim().toLowerCase().replace(/^(dn|de|ø|⌀|d)\s*/, '').replace(/\s*mm$/, '');
  const inches = s.endsWith('"') || s.endsWith('in');
  s = s.replace(/("|in)$/, '').trim();
  let n: number | null = null;
  const frac = s.match(/^(\d+)(?:[- ](\d+)\/(\d+))?$|^(\d+)\/(\d+)$/);
  if (frac && (frac[2] || frac[4])) {
    n = frac[4] ? parseInt(frac[4]) / parseInt(frac[5]) : parseInt(frac[1]) + parseInt(frac[2]) / parseInt(frac[3]);
  } else {
    const f = parseFloat(s);
    n = Number.isFinite(f) ? f : null;
  }
  if (n === null || !(n > 0)) return null;
  const disp = sizeDisplayUnit(unit);
  if (inches && disp === 'mm') return Math.round(n * 25.4);
  // NPS typed in an imperial project for a pipe size is in inches already.
  return n;
}

/** Display label of one size value (mm / inch), e.g. "400", "16\"". */
function lenLabel(mm: number, unit: ProjectUnit | undefined): string {
  if (sizeDisplayUnit(unit) === 'in') {
    const inch = mm / 25.4;
    return `${Math.round(inch * 4) / 4}"`;
  }
  return String(Math.round(mm));
}

/**
 * Size label of a run or port, e.g. "DN65", "de110", "Ø250", "400×300",
 * '2-1/2"' (imperial pipe). `sizeX` / `sizeY` are in metres.
 */
export function formatMepSize(table: string, shape: string, sizeX: number, sizeY: number, opts: { material?: string; unit?: ProjectUnit } = {}): string {
  if (!(sizeX > 0)) return '';
  const unit = opts.unit;
  const mmX = sizeX * 1000;
  if (shape === 'round' || table === 'pipe' || table === 'conduit') {
    if (table === 'pipe') {
      if (isPlasticPipe(opts.material)) {
        const de = matchSeries(mmX, DE_MM);
        return de ? `de${de}` : `Ø${lenLabel(mmX, unit)}`;
      }
      const dn = matchSeries(mmX, DN_MM);
      if (dn) return sizeDisplayUnit(unit) === 'in' ? NPS[dn] : `DN${dn}`;
    }
    return `Ø${lenLabel(mmX, unit)}`;
  }
  return `${lenLabel(mmX, unit)}×${lenLabel((sizeY > 0 ? sizeY : sizeX) * 1000, unit)}`;
}

/** Pick-list options for a size field: value = stored (project units), label = DN65 / 400 / Ø250. */
export function sizeOptions(table: string, key: SizeKey, shape: string | undefined, material: string | undefined, unit: ProjectUnit | undefined): { value: number; label: string }[] {
  return sizeSeries(table, key, shape, material).map(mm => {
    const v = fromMetres(mm / 1000, unit);
    let label: string;
    if (table === 'pipe') label = isPlasticPipe(material) ? `de${mm}` : (sizeDisplayUnit(unit) === 'in' ? `${NPS[mm] ?? lenLabel(mm, unit)}` : `DN${mm}`);
    else label = lenLabel(mm, unit);
    return { value: unit === 'mm' ? mm : Math.round(v * 1e6) / 1e6, label };
  });
}
