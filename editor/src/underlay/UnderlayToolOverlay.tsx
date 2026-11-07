import { useCoreEditorState } from '../state/EditorContext.tsx';
import type { Point } from '../model/elements.ts';
import { useUnderlaySnapshot, useUnderlayStore } from './UnderlayContext.tsx';
import { assetKey, localBounds } from './store.ts';
import { localToWorld } from './transform.ts';

const ACCENT = '#f97316';

/**
 * Outline of the selected underlay plus the picks of a running interaction
 * (calibration line, move vector, rotation arms). Plan coordinates.
 */
export default function UnderlayToolOverlay({ scale }: { scale: number }) {
  const store = useUnderlayStore();
  const snap = useUnderlaySnapshot();
  const { currentLevel } = useCoreEditorState();
  if (!store) return null;
  const selected = snap.underlays.find(u => u.id === snap.selectedId && u.levelId === currentLevel);
  const sw = 0.12 / scale;
  const r = 0.35 / scale;

  let outline: string | null = null;
  if (selected?.visible) {
    const asset = snap.assets.get(assetKey(selected));
    const b = asset && localBounds(asset);
    if (b) {
      const placed = store.displayed(selected);
      outline = [
        { x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY },
      ].map(p => localToWorld(placed, p)).map(p => `${p.x},${p.y}`).join(' ');
    }
  }

  const { mode, cursor, calibration } = snap;
  const picks: Point[] = [];
  const lines: [Point, Point][] = [];
  if (mode?.kind === 'calibrate') {
    picks.push(...mode.points);
    if (mode.points[0] && cursor) lines.push([mode.points[0], cursor]);
  } else if (mode?.kind === 'move' && mode.base) {
    picks.push(mode.base);
    if (cursor) lines.push([mode.base, cursor]);
  } else if (mode?.kind === 'rotate' && mode.center) {
    picks.push(mode.center);
    if (mode.ref) { picks.push(mode.ref); lines.push([mode.center, mode.ref]); }
    if (cursor) lines.push([mode.center, cursor]);
  }
  if (calibration) {
    picks.push(calibration.p1, calibration.p2);
    lines.push([calibration.p1, calibration.p2]);
  }

  if (!outline && picks.length === 0 && lines.length === 0) return null;
  return (
    <g className="underlay-tool-overlay" transform="scale(1,-1)" pointerEvents="none">
      {outline && (
        <polygon points={outline} fill="none" stroke={ACCENT} strokeWidth={sw} strokeDasharray={`${sw * 6} ${sw * 4}`} opacity={0.8} />
      )}
      {lines.map(([a, b], i) => (
        <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={ACCENT} strokeWidth={sw * 1.5} />
      ))}
      {picks.map((p, i) => (
        <g key={i}>
          <circle cx={p.x} cy={p.y} r={r} fill="white" stroke={ACCENT} strokeWidth={sw * 1.5} />
          <circle cx={p.x} cy={p.y} r={r * 0.35} fill={ACCENT} />
        </g>
      ))}
    </g>
  );
}
