/**
 * Circuit — an electrical branch circuit on a panel (CSV-only, hosted on the
 * panel like a connector). Devices join through `circuit_id`.
 *
 * Plan: the wiring as arcs, home run from the panel to the nearest device
 * then device to device, with the circuit number and connected load. 3D:
 * nothing.
 */
import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, PointElement, Point } from '../model/elements.ts';
import { wiringOrder } from '../mep/circuits.ts';
import { useMepView } from '../mep/mepView.ts';
import { PlanText } from '../mep/planSymbols.tsx';

export interface CircuitFacts {
  id: string;
  panel: Point;
  points: Point[];
  label: string;
}

const WIRE = '#b45309';

function CircuitWiring({ facts, selected }: { facts: CircuitFacts; selected: boolean }) {
  const view = useMepView();
  const active = selected || view.circuit === facts.id;
  if (!view.showCircuits && !active) return null;
  const color = active ? '#3a7bff' : WIRE;
  const pts = [facts.panel, ...facts.points];
  const arcs: string[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const dx = b.x - a.x, dy = b.y - a.y;
    const bulge = 0.18;
    arcs.push(`M ${a.x},${a.y} Q ${mx - dy * bulge},${my + dx * bulge} ${b.x},${b.y}`);
  }
  const first = pts[1];
  return (
    <g data-id={facts.id}>
      {arcs.map((d, i) => (
        <path key={i} d={d} fill="none" stroke={color} strokeWidth={active ? 0.035 : 0.022} strokeDasharray={i === 0 ? undefined : '0.12,0.06'} data-id={facts.id} />
      ))}
      {/* Home-run arrow at the panel. */}
      {first && (() => {
        const ux = facts.panel.x - first.x, uy = facts.panel.y - first.y;
        const l = Math.hypot(ux, uy) || 1;
        const tip = facts.panel;
        const bx = tip.x - (ux / l) * 0.2, by = tip.y - (uy / l) * 0.2;
        return <polygon points={`${tip.x},${tip.y} ${bx - (uy / l) * 0.07},${by + (ux / l) * 0.07} ${bx + (uy / l) * 0.07},${by - (ux / l) * 0.07}`} fill={color} />;
      })()}
      {first && (
        <PlanText x={(facts.panel.x + first.x) / 2} y={(facts.panel.y + first.y) / 2 + 0.2} size={0.16} color={color} text={facts.label} weight={600} />
      )}
    </g>
  );
}

export const circuitModule: ElementModule<CircuitFacts> = {
  table: 'circuit',
  discipline: 'mep',
  archetype: 'hosted',
  geometryType: 'point',
  placementType: 'free_point',
  prefix: 'ci',
  hostTables: ['equipment'],
  csvOnly: true,
  csvHeaders: ['number', 'host_id', 'name', 'voltage', 'poles', 'rating'],
  defaults: { host_id: '', name: '', voltage: '230', poles: '1', rating: '16' },
  drawingFields: [],
  propertyFields: [],
  layerStyle: { displayName: 'Circuits', color: WIRE, icon: '⌒', order: 13.8 },
  renderZIndex: 94,
  hiddenFromToolbar: true,

  geometry(el: CanonicalElement, ctx: GeometryContext): CircuitFacts | null {
    const panelId = el.hostId || el.attrs.host_id || '';
    const panel = ctx.elementById(panelId);
    if (!panel || panel.geometry !== 'point') return null;
    const devices: PointElement[] = [];
    for (const t of ['terminal', 'equipment']) {
      for (const d of ctx.elementsByTable(t)) {
        if (d.geometry === 'point' && (d.attrs.circuit_id || '') === el.id) devices.push(d as PointElement);
      }
    }
    const order = wiringOrder((panel as PointElement).position, devices);
    const load = devices.reduce((s, d) => s + (parseFloat(d.attrs.load || '0') || 0), 0);
    const num = el.attrs.number || el.id;
    return {
      id: el.id,
      panel: (panel as PointElement).position,
      points: order.map(d => d.position),
      label: `${panel.attrs.number || panelId}-${num}  ${devices.length}× · ${Math.round(load)} W`,
    };
  },

  draw2D(facts, drawCtx): ReactNode {
    if (facts.points.length === 0) return null;
    return <CircuitWiring facts={facts} selected={drawCtx.selected} />;
  },

  draw3D(): ReactNode {
    return null;
  },

  bbox(facts) {
    let minX = facts.panel.x, minY = facts.panel.y, maxX = facts.panel.x, maxY = facts.panel.y;
    for (const p of facts.points) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  },
};

registerElement(circuitModule);
