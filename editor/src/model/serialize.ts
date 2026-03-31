import type { CanonicalElement, LineElement, SpatialLineElement, PointElement, PolygonElement } from './elements.ts';
import { computeBounds } from './elements.ts';
import type { CsvRow } from '../types.ts';
import { csvHeadersForTable } from './tableRegistry.ts';

/** Tables that are CSV-only (no SVG geometry file). */
const CSV_ONLY_TABLES = new Set(['door', 'window', 'space']);

/**
 * Group elements by discipline/tableName key.
 */
export function groupByLayer(elements: CanonicalElement[]): Map<string, CanonicalElement[]> {
  const groups = new Map<string, CanonicalElement[]>();
  for (const el of elements) {
    const key = `${el.discipline}/${el.tableName}`;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(el);
  }
  return groups;
}

/**
 * Check if a table is CSV-only (no SVG file).
 * Opening is dual-mode: returns false so SVG is checked per-element.
 */
export function isCsvOnlyTable(tableName: string): boolean {
  return CSV_ONLY_TABLES.has(tableName);
}

/** Tables that support dual mode (some elements have SVG, some don't). */
const DUAL_MODE_TABLES = new Set(['opening']);

/**
 * Serialize elements of one layer to canonical SVG string.
 * Returns empty string for CSV-only tables (no SVG needed).
 */
export function serializeToSvg(elements: CanonicalElement[]): string {
  if (elements.length === 0) return '';

  // CSV-only tables don't have SVG
  const tableName = elements[0].tableName;
  if (CSV_ONLY_TABLES.has(tableName)) return '';

  // Dual-mode tables: only serialize SVG for polygon elements (slab openings)
  if (DUAL_MODE_TABLES.has(tableName)) {
    const svgElements = elements.filter(el => el.geometry === 'polygon');
    if (svgElements.length === 0) return '';
    // Recurse with only polygon elements to generate their SVG
    elements = svgElements;
  }

  const bounds = computeBounds(elements);
  const vb = bounds ? `${r(bounds.x)} ${r(bounds.y)} ${r(bounds.w)} ${r(bounds.h)}` : '0 0 100 100';

  const innerElements: string[] = [];

  for (const el of elements) {
    switch (el.geometry) {
      case 'line':
        innerElements.push(serializeLine(el));
        break;
      case 'spatial_line':
        innerElements.push(serializeSpatialLine(el));
        break;
      case 'point':
        innerElements.push(serializePoint(el));
        break;
      case 'polygon':
        innerElements.push(serializePolygon(el));
        break;
    }
  }

  return `<?xml version="1.0" encoding="utf-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">\n  <g transform="scale(1,-1)">\n${innerElements.map(s => '    ' + s).join('\n')}\n  </g>\n</svg>`;
}

function serializeLine(el: LineElement): string {
  return `<path id="${el.id}" d="M ${r(el.start.x)},${r(el.start.y)} L ${r(el.end.x)},${r(el.end.y)}" />`;
}

function serializeSpatialLine(el: SpatialLineElement): string {
  // SVG is 2D projection — same as line, z lives in CSV only
  return `<path id="${el.id}" d="M ${r(el.start.x)},${r(el.start.y)} L ${r(el.end.x)},${r(el.end.y)}" />`;
}

function serializePoint(el: PointElement): string {
  if (el.width === el.height) {
    // Circular: use <circle>
    const radius = el.width / 2;
    return `<circle id="${el.id}" cx="${r(el.position.x)}" cy="${r(el.position.y)}" r="${r(radius)}" />`;
  }
  const x = el.position.x - el.width / 2;
  const y = el.position.y - el.height / 2;
  return `<rect id="${el.id}" x="${r(x)}" y="${r(y)}" width="${r(el.width)}" height="${r(el.height)}" />`;
}

function serializePolygon(el: PolygonElement): string {
  const points = el.vertices.map(v => `${r(v.x)},${r(v.y)}`).join(' ');
  return `<polygon id="${el.id}" points="${points}" />`;
}

/** Round to 3 decimal places */
function r(n: number): string {
  return Number(n.toFixed(3)).toString();
}

/**
 * Serialize elements of one layer to CSV string.
 */
export function serializeToCsv(elements: CanonicalElement[], tableName: string): string {
  if (elements.length === 0) return '';

  // Collect all attribute keys (preserve order from first element, then add any extras)
  const headerSet = new Set<string>();
  const csvHeaders = getCsvHeaders(tableName);
  for (const h of csvHeaders) headerSet.add(h);
  for (const el of elements) {
    for (const k of Object.keys(el.attrs)) {
      headerSet.add(k);
    }
  }

  const headers = ['id', ...headerSet];
  const lines: string[] = [headers.join(',')];

  for (const el of elements) {
    const values = headers.map(h => {
      if (h === 'id') return el.id;
      const v = el.attrs[h] ?? '';
      // Quote if contains comma or quote
      if (v.includes(',') || v.includes('"')) {
        return `"${v.replace(/"/g, '""')}"`;
      }
      return v;
    });
    lines.push(values.join(','));
  }

  return lines.join('\n');
}

function getCsvHeaders(tableName: string): string[] {
  return csvHeadersForTable(tableName);
}

/**
 * Convert elements to CsvRow map (for processor.ts compatibility).
 */
export function elementsToCsvRows(elements: CanonicalElement[]): Map<string, CsvRow> {
  const map = new Map<string, CsvRow>();
  for (const el of elements) {
    map.set(el.id, { id: el.id, ...el.attrs });
  }
  return map;
}
