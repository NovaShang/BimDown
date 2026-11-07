/**
 * Electrical circuits: a `circuit` row hosted on a panel; devices join it
 * through `circuit_id`. Helpers for the MEP panel (create, assign, loads)
 * and the wiring order used to draw the home run and device-to-device arcs.
 */
import type { CanonicalElement, PointElement } from '../model/elements.ts';
import { generateId } from '../model/ids.ts';
import { reservedIds } from './reservedIds.ts';
import { defaultAttrs } from '../model/defaults.ts';

type P = { x: number; y: number };

export interface CircuitSummary {
  id: string;
  number: string;
  name: string;
  panelId: string;
  devices: PointElement[];
  load: number;
  voltage: number;
  rating: number;
}

const DEVICE_TABLES = new Set(['terminal', 'equipment']);

export function isPanel(el: CanonicalElement): boolean {
  return el.tableName === 'equipment' && (el.attrs.equipment_type === 'panelboard' || el.attrs.equipment_type === 'transformer');
}

/** Devices on `circuitId`, ordered for wiring: nearest neighbour from the panel. */
export function wiringOrder(panel: P, devices: PointElement[]): PointElement[] {
  const left = [...devices];
  const out: PointElement[] = [];
  let at = panel;
  while (left.length > 0) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < left.length; i++) {
      const d = Math.hypot(left[i].position.x - at.x, left[i].position.y - at.y);
      if (d < bd) { bd = d; bi = i; }
    }
    const next = left.splice(bi, 1)[0];
    out.push(next);
    at = next.position;
  }
  return out;
}

export function circuitsIn(elements: ReadonlyMap<string, CanonicalElement>): CircuitSummary[] {
  const byCircuit = new Map<string, PointElement[]>();
  for (const el of elements.values()) {
    if (!DEVICE_TABLES.has(el.tableName) || el.geometry !== 'point') continue;
    const c = (el.attrs.circuit_id || '').trim();
    if (!c) continue;
    const list = byCircuit.get(c) ?? [];
    list.push(el as PointElement);
    byCircuit.set(c, list);
  }
  const out: CircuitSummary[] = [];
  for (const el of elements.values()) {
    if (el.tableName !== 'circuit') continue;
    const devices = byCircuit.get(el.id) ?? [];
    out.push({
      id: el.id,
      number: el.attrs.number || '',
      name: el.attrs.name || '',
      panelId: el.hostId || el.attrs.host_id || '',
      devices,
      load: devices.reduce((s, d) => s + (parseFloat(d.attrs.load || '0') || 0), 0),
      voltage: parseFloat(el.attrs.voltage || '0') || 0,
      rating: parseFloat(el.attrs.rating || '0') || 0,
    });
  }
  return out.sort((a, b) => a.panelId.localeCompare(b.panelId) || a.number.localeCompare(b.number, undefined, { numeric: true }));
}

/** A new circuit on `panelId` with the next free number. */
export function newCircuit(panelId: string, elements: ReadonlyMap<string, CanonicalElement>, levelId: string): CanonicalElement {
  const ids = reservedIds(elements);
  const id = generateId('circuit', ids);
  let n = 1;
  const used = new Set([...elements.values()].filter(e => e.tableName === 'circuit' && (e.hostId || e.attrs.host_id) === panelId).map(e => e.attrs.number));
  while (used.has(String(n))) n++;
  const panel = elements.get(panelId) as PointElement | undefined;
  return {
    id, tableName: 'circuit', discipline: 'mep', geometry: 'point',
    position: panel?.position ?? { x: 0, y: 0 }, width: 0, height: 0, hostId: panelId,
    attrs: { ...defaultAttrs('circuit', levelId), id, host_id: panelId, number: String(n), name: '', voltage: '230', poles: '1', rating: '16' },
  };
}
