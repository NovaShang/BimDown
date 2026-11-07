import { parseCsv } from '../utils/loader.ts';
import type { Underlay } from './types.ts';

const HEADER = ['id', 'name', 'level_id', 'file', 'page', 'x', 'y', 'rotation', 'scale', 'opacity', 'visible', 'locked', 'hidden_layers'];

function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Parse `global/underlay.csv`; rows without an id, level or file are dropped. */
export function parseUnderlayCsv(text: string | null): Underlay[] {
  if (!text) return [];
  return parseCsv(text)
    .filter(r => r.id && r.level_id && r.file)
    .map(r => ({
      id: r.id,
      name: r.name ?? '',
      levelId: r.level_id,
      file: r.file,
      page: Math.max(1, Math.round(num(r.page, 1))),
      x: num(r.x, 0),
      y: num(r.y, 0),
      rotation: num(r.rotation, 0),
      scale: num(r.scale, 1) || 1,
      opacity: Math.min(1, Math.max(0, num(r.opacity, 0.5))),
      visible: r.visible !== 'false',
      locked: r.locked === 'true',
      hiddenLayers: (r.hidden_layers ?? '').split(';').map(s => s.trim()).filter(Boolean),
    }));
}

function cell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Up to 10 significant digits: keeps CSV diffs readable without losing precision. */
function fmt(n: number): string {
  return String(Number(n.toPrecision(10)));
}

export function serializeUnderlayCsv(underlays: readonly Underlay[]): string {
  const rows = underlays.map(u => [
    u.id, u.name, u.levelId, u.file, String(u.page),
    fmt(u.x), fmt(u.y), fmt(u.rotation), fmt(u.scale), fmt(u.opacity),
    String(u.visible), String(u.locked), u.hiddenLayers.join(';'),
  ].map(cell).join(','));
  return [HEADER.join(','), ...rows].join('\n') + '\n';
}

/** Next free `ul-N` id. */
export function nextUnderlayId(underlays: readonly Underlay[]): string {
  const used = new Set(underlays.map(u => u.id));
  let n = 1;
  while (used.has(`ul-${n}`)) n++;
  return `ul-${n}`;
}

/** A file name safe for `underlays/` that doesn't clash with existing ones. */
export function underlayFileName(original: string, taken: ReadonlySet<string>): string {
  const dot = original.lastIndexOf('.');
  const ext = dot === -1 ? '' : original.slice(dot).toLowerCase();
  const stem = (dot === -1 ? original : original.slice(0, dot))
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'underlay';
  let name = `${stem}${ext}`;
  for (let n = 2; taken.has(`underlays/${name}`); n++) name = `${stem}-${n}${ext}`;
  return `underlays/${name}`;
}
