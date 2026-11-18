/**
 * Electrical circuits: a `circuit` row hosted on a panel; devices join it
 * through `circuit_id`. Helpers for the MEP panel (create, assign, loads)
 * and the wiring order used to draw the home run and device-to-device arcs.
 */
import type { CanonicalElement, PointElement } from '../model/elements.ts';
import { generateId } from '../model/ids.ts';
import { reservedIds } from './reservedIds.ts';
import { defaultAttrs } from '../model/defaults.ts';
import { circuitCurrent, circuitPhases, DEFAULT_POWER_FACTOR, PHASES, type Phase } from './mepCheck.ts';

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
  poles: number;
  /** circuit.phase as written ('' = unassigned). */
  phase: string;
  /** Phases it is on (none when unassigned). */
  phases: Phase[];
  powerFactor: number;
  /** Line current, A. */
  current: number;
  /** Load per phase, W (split evenly over the circuit's phases). */
  perPhase: Record<Phase, number>;
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
    const load = devices.reduce((s, d) => s + (parseFloat(d.attrs.load || '0') || 0), 0);
    const voltage = parseFloat(el.attrs.voltage || '0') || 0;
    const poles = parseInt(el.attrs.poles || '0') || 0;
    const phases = circuitPhases(el.attrs.phase, poles);
    const pf = parseFloat(el.attrs.power_factor || '');
    const powerFactor = pf > 0 && pf <= 1 ? pf : DEFAULT_POWER_FACTOR;
    const perPhase = { L1: 0, L2: 0, L3: 0 };
    for (const ph of phases) perPhase[ph] = load / phases.length;
    out.push({
      id: el.id,
      number: el.attrs.number || '',
      name: el.attrs.name || '',
      panelId: el.hostId || el.attrs.host_id || '',
      devices,
      load,
      voltage,
      rating: parseFloat(el.attrs.rating || '0') || 0,
      poles, phase: (el.attrs.phase || '').trim(), phases, powerFactor,
      current: circuitCurrent(load, voltage, phases.length, powerFactor),
      perPhase,
    });
  }
  return out.sort((a, b) => a.panelId.localeCompare(b.panelId) || a.number.localeCompare(b.number, undefined, { numeric: true }));
}

export interface PanelLoad {
  panelId: string;
  circuits: CircuitSummary[];
  perPhase: Record<Phase, number>;
  /** Connected load on circuits with no phase yet, W. */
  unassigned: number;
  total: number;
  /** Largest deviation of a phase from the phase average, percent of the average (0 when balanced or empty). */
  imbalance: number;
}

/** Imbalance %: max |P_phase − avg| / avg × 100. */
export function phaseImbalance(perPhase: Record<Phase, number>): number {
  const v = PHASES.map(p => perPhase[p]);
  const avg = (v[0] + v[1] + v[2]) / 3;
  if (!(avg > 0)) return 0;
  return (Math.max(...v.map(x => Math.abs(x - avg))) / avg) * 100;
}

/** Per-panel phase loads and imbalance. */
export function panelLoads(circuits: CircuitSummary[]): PanelLoad[] {
  const by = new Map<string, CircuitSummary[]>();
  for (const c of circuits) {
    const list = by.get(c.panelId) ?? [];
    list.push(c);
    by.set(c.panelId, list);
  }
  return [...by].map(([panelId, list]) => {
    const perPhase = { L1: 0, L2: 0, L3: 0 };
    let unassigned = 0;
    for (const c of list) {
      if (c.phases.length === 0) unassigned += c.load;
      for (const p of PHASES) perPhase[p] += c.perPhase[p];
    }
    return { panelId, circuits: list, perPhase, unassigned, total: perPhase.L1 + perPhase.L2 + perPhase.L3 + unassigned, imbalance: phaseImbalance(perPhase) };
  });
}

const PAIRS = ['L1L2', 'L2L3', 'L3L1'];

/**
 * Auto-balance: phase suggestions for a panel's single- and two-phase
 * circuits (three-phase ones load all phases equally and stay). Largest
 * load first onto the least loaded phase (pair). Returns only changes, and
 * the imbalance after them.
 */
export function balancePhases(circuits: CircuitSummary[]): { changes: Map<string, string>; imbalance: number; perPhase: Record<Phase, number> } {
  const perPhase = { L1: 0, L2: 0, L3: 0 };
  const movable: CircuitSummary[] = [];
  for (const c of circuits) {
    if (c.phases.length === 3) { for (const p of PHASES) perPhase[p] += c.load / 3; continue; }
    movable.push(c);
  }
  const changes = new Map<string, string>();
  const order = [...movable].sort((a, b) => b.load - a.load || a.number.localeCompare(b.number, undefined, { numeric: true }));
  for (const c of order) {
    const twoPole = c.phases.length === 2 || (c.phases.length === 0 && c.poles === 2);
    let best: string;
    if (twoPole) {
      best = PAIRS.reduce((a, b) => {
        const la = PHASES.filter(p => a.includes(p)).reduce((s, p) => s + perPhase[p], 0);
        const lb = PHASES.filter(p => b.includes(p)).reduce((s, p) => s + perPhase[p], 0);
        return lb < la - 1e-9 ? b : a;
      });
      for (const p of PHASES) if (best.includes(p)) perPhase[p] += c.load / 2;
    } else {
      // Keep the current phase on a tie, so a balanced panel suggests nothing
      const cur = c.phases.length === 1 ? c.phases[0] : null;
      best = PHASES.reduce((a, b) => (perPhase[b] < perPhase[a] - 1e-9 ? b : a));
      if (cur && perPhase[cur] <= perPhase[best as Phase] + 1e-9) best = cur;
      perPhase[best as Phase] += c.load;
    }
    if (best !== c.phase) changes.set(c.id, best);
  }
  // No better than today and nothing unassigned: suggest nothing
  const now = panelLoads(circuits)[0];
  if (now && now.unassigned === 0 && phaseImbalance(perPhase) >= now.imbalance - 1e-6) {
    return { changes: new Map(), imbalance: now.imbalance, perPhase: now.perPhase };
  }
  return { changes, imbalance: phaseImbalance(perPhase), perPhase };
}

/** The least loaded phase of a panel (for a new single-phase circuit). */
export function lightestPhase(circuits: CircuitSummary[], panelId: string): Phase {
  const pl = panelLoads(circuits.filter(c => c.panelId === panelId))[0];
  if (!pl) return 'L1';
  return PHASES.reduce((a, b) => (pl.perPhase[b] < pl.perPhase[a] - 1e-9 ? b : a));
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
    attrs: {
      ...defaultAttrs('circuit', levelId), id, host_id: panelId, number: String(n), name: '', voltage: '230', poles: '1', rating: '16',
      phase: lightestPhase(circuitsIn(elements), panelId), power_factor: '',
    },
  };
}
