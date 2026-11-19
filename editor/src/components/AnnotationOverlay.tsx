import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useCoreEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import type { CanonicalElement, LineElement, Point } from '../model/elements.ts';
import { toElementId, generateId } from '../model/ids.ts';
import { ANNOTATION_DISCIPLINE, fmtCoord } from '../annotation/model.ts';
import {
  formatDimension, parseDimensionInput, thicknessOf, sub, add, mul, len, mid, readableAngle,
  type Lookup,
} from '../annotation/geometry.ts';
import { chainDirection, chainRows, dimensionElements, type PickedRef, type DimMode, type DimRowDraft } from '../annotation/pick.ts';
import { tempDimsFor, parallelTempDims, type TempDim } from '../annotation/tempDims.ts';
import { annotationToolState, placeDimensions } from '../tools/annotationTools.ts';

const TEMP = '#0891b2';
const PICK = '#e76f51';
const WALL_TABLES = new Set(['wall', 'structure_wall', 'curtain_wall']);

interface Props {
  /** Screen-constant sizing: 1/scale model units ≈ 15 px. */
  scale: number;
}

interface Editing {
  dim: TempDim;
  rect: { left: number; top: number; width: number; height: number };
}

/** Reference highlight: the referenced line (face / centre line) or a dot. */
function RefMark({ pick, lookup, color, px }: { pick: PickedRef; lookup: Lookup; color: string; px: number }) {
  const el = pick.elementId ? lookup(pick.elementId) : undefined;
  if (pick.dir && el && (el.geometry === 'line' || el.geometry === 'spatial_line') && !el.hostId) {
    const ln = el as LineElement;
    const n = { x: -pick.dir.y, y: pick.dir.x };
    const shift = mul(n, (pick.point.x - ln.start.x) * n.x + (pick.point.y - ln.start.y) * n.y);
    const a = add(ln.start, shift), b = add(ln.end, shift);
    return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={3 * px} strokeLinecap="round" opacity={0.85} />;
  }
  return <circle cx={pick.point.x} cy={pick.point.y} r={5 * px} fill={color} stroke="white" strokeWidth={1.5 * px} />;
}

/** One dimension drawn in screen-constant overlay style. */
function OverlayDim({ p1, p2, offset, label, color, px, onLabel, dashed }: {
  p1: Point; p2: Point; offset: number; label: string; color: string; px: number;
  onLabel?: (rect: DOMRect) => void; dashed?: boolean;
}) {
  const d = sub(p2, p1);
  const l = len(d);
  if (l < 1e-6) return null;
  const u = mul(d, 1 / l);
  const n = { x: -u.y, y: u.x };
  const d1 = add(p1, mul(n, offset)), d2 = add(p2, mul(n, offset));
  const tick = mul(add(u, n), 5 * px / Math.SQRT2);
  const angle = readableAngle(u);
  const m = mid(d1, d2);
  const fs = 11 * px;
  const w = (label.length * 0.62 + 0.8) * fs;
  return (
    <g>
      {Math.abs(offset) > 1e-6 && (
        <>
          <line x1={p1.x} y1={p1.y} x2={d1.x + n.x * 4 * px * Math.sign(offset)} y2={d1.y + n.y * 4 * px * Math.sign(offset)} stroke={color} strokeWidth={px} strokeDasharray={`${3 * px} ${2 * px}`} />
          <line x1={p2.x} y1={p2.y} x2={d2.x + n.x * 4 * px * Math.sign(offset)} y2={d2.y + n.y * 4 * px * Math.sign(offset)} stroke={color} strokeWidth={px} strokeDasharray={`${3 * px} ${2 * px}`} />
        </>
      )}
      <line x1={d1.x} y1={d1.y} x2={d2.x} y2={d2.y} stroke={color} strokeWidth={1.2 * px} strokeDasharray={dashed ? `${4 * px} ${3 * px}` : undefined} />
      {[d1, d2].map((q, i) => (
        <line key={i} x1={q.x - tick.x} y1={q.y - tick.y} x2={q.x + tick.x} y2={q.y + tick.y} stroke={color} strokeWidth={1.6 * px} />
      ))}
      <g transform={`translate(${m.x},${m.y}) scale(1,-1) rotate(${-angle})`}
        style={{ pointerEvents: onLabel ? 'all' : 'none', cursor: onLabel ? 'text' : undefined }}
        onPointerDown={onLabel ? e => e.stopPropagation() : undefined}
        onClick={onLabel ? e => { e.stopPropagation(); onLabel((e.currentTarget as SVGGElement).getBoundingClientRect()); } : undefined}
        data-temp-dim="1"
      >
        <rect x={-w / 2} y={-fs * 0.75} width={w} height={fs * 1.5} rx={3 * px} fill="white" stroke={color} strokeWidth={0.8 * px} opacity={0.95} />
        <text x={0} y={0} textAnchor="middle" dominantBaseline="central" fontSize={fs} fontFamily="Inter, sans-serif" fontWeight={600} fill={color}>{label}</text>
      </g>
    </g>
  );
}

/**
 * Canvas overlay for annotation work: the dimension tool's picks and rubber
 * band, the text tool's input box, and temporary dimensions around the
 * selected (or being drawn) wall / door / window / column — click a value to
 * type a new one, or keep it as a permanent dimension.
 */
export default function AnnotationOverlay({ scale }: Props) {
  const { t } = useTranslation();
  const state = useCoreEditorState();
  const dispatch = useEditorDispatch();
  const [editing, setEditing] = useState<Editing | null>(null);
  const elements = state.document?.elements;
  const lookup: Lookup = id => elements?.get(id);
  const px = 1 / (15 * Math.max(scale, 1e-6));

  // Temporary dimensions: one selected element with the select tool, or a wall being drawn
  const tempDims = useMemo<TempDim[]>(() => {
    if (!elements || state.readonly) return [];
    if ((state.activeTool === 'select') && state.selectedIds.size === 1) {
      const el = elements.get(toElementId([...state.selectedIds][0]));
      return el ? tempDimsFor(el, elements) : [];
    }
    const ds = state.drawingState;
    if (state.activeTool === 'draw_line' && state.drawingTarget && WALL_TABLES.has(state.drawingTarget.tableName) && ds?.points.length && ds.cursor) {
      return parallelTempDims(ds.points[ds.points.length - 1], ds.cursor, null, elements.values(), id => elements.get(id));
    }
    return [];
  }, [elements, state.readonly, state.activeTool, state.selectedIds, state.drawingState, state.drawingTarget]);

  // Close the editor when the selection or tool changes
  useEffect(() => { setEditing(null); }, [state.selectedIds, state.activeTool]);

  // Enter places a pending dimension chain at the cursor
  useEffect(() => {
    if (state.activeTool !== 'draw_dimension') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || (e.target as HTMLElement).tagName === 'INPUT') return;
      const cursor = state.drawingState?.cursor;
      if (!cursor || annotationToolState.picks.length < 2) return;
      placeDimensions(dispatch, state.document?.elements, (state.drawingAttrs.dim_mode || 'aligned') as DimMode, cursor);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, dispatch]);

  const apply = (dim: TempDim, raw: string) => {
    const v = parseDimensionInput(raw);
    if (v === null || !dim.apply) return;
    const action = dim.apply(v);
    if (action) dispatch(action);
  };
  const pin = (row: DimRowDraft | undefined) => {
    if (!row || !elements) return;
    dispatch({ type: 'CREATE_ELEMENTS', elements: dimensionElements([row], elements.keys()), description: 'Add dimension', selectPrimary: false });
  };

  const overlay: React.ReactNode[] = [];

  // ── Dimension tool ──
  if (state.activeTool === 'draw_dimension' && elements) {
    const { picks, hover } = annotationToolState;
    const cursor = state.drawingState?.cursor ?? null;
    if (state.drawingAttrs.dim_mode === 'wall_run') {
      if (hover) overlay.push(<RefMark key="hover" pick={{ ...hover, dir: undefined }} lookup={lookup} color={TEMP} px={px} />);
      const wall = hover ? elements.get(hover.elementId) : undefined;
      if (wall && wall.geometry === 'line') {
        overlay.push(<line key="wall" x1={wall.start.x} y1={wall.start.y} x2={wall.end.x} y2={wall.end.y}
          stroke={TEMP} strokeWidth={thicknessOf(wall, lookup)} opacity={0.25} />);
      }
    } else {
      if (hover) overlay.push(<RefMark key="hover" pick={hover} lookup={lookup} color={TEMP} px={px} />);
      picks.forEach((p, i) => overlay.push(<RefMark key={`p${i}`} pick={p} lookup={lookup} color={PICK} px={px} />));
      if (cursor && picks.length >= 2) {
        const mode = (state.drawingAttrs.dim_mode || 'aligned') as DimMode;
        const rows = chainRows(picks, cursor, chainDirection(picks, cursor, mode));
        rows.forEach((r, i) => {
          const g = rowLine(r);
          if (g) overlay.push(<OverlayDim key={`r${i}`} p1={g.p1} p2={g.p2} offset={0} label={formatDimension(g.value)} color={PICK} px={px} />);
        });
      } else if (cursor && picks.length === 1) {
        overlay.push(<line key="rb" x1={picks[0].point.x} y1={picks[0].point.y} x2={cursor.x} y2={cursor.y}
          stroke={PICK} strokeWidth={px} strokeDasharray={`${4 * px} ${3 * px}`} />);
      }
    }
  }

  // ── Temporary dimensions ──
  tempDims.forEach(dim => overlay.push(
    <OverlayDim key={dim.key} p1={dim.p1} p2={dim.p2} offset={dim.offset} label={formatDimension(dim.value)}
      color={TEMP} px={px} dashed
      onLabel={dim.apply || dim.row ? rect => setEditing({ dim, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } }) : undefined} />,
  ));

  const pending = state.activeTool === 'draw_text' ? annotationToolState.pendingText : null;

  return (
    <>
      <g className="annotation-overlay" transform="scale(1,-1)" style={{ pointerEvents: 'none' }}>{overlay}</g>
      {editing && createPortal(
        <TempDimEditor
          key={editing.dim.key}
          dim={editing.dim}
          rect={editing.rect}
          onApply={v => { apply(editing.dim, v); setEditing(null); }}
          onPin={() => { pin(editing.dim.row); setEditing(null); }}
          onClose={() => setEditing(null)}
          pinLabel={t('annot.keepDimension')}
        />,
        document.body,
      )}
      {pending && createPortal(
        <TextNoteInput
          key={`${pending.client.x},${pending.client.y}`}
          at={pending.client}
          placeholder={t('annot.textPlaceholder')}
          onDone={text => {
            annotationToolState.pendingText = null;
            dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: pending.point } });
            if (!text.trim() || !elements) return;
            const id = generateId('text_note', new Set(elements.keys()));
            const element: CanonicalElement = {
              geometry: 'point', id, tableName: 'text_note', discipline: ANNOTATION_DISCIPLINE,
              position: pending.point, width: 0.3, height: 0.3,
              attrs: {
                x: fmtCoord(pending.point.x), y: fmtCoord(pending.point.y),
                text: text.replace(/\n/g, '\\n'), size: state.drawingAttrs.size || '0.25', rotation: '0',
              },
            };
            dispatch({ type: 'CREATE_ELEMENT', element });
          }}
        />,
        document.body,
      )}
    </>
  );
}

function rowLine(r: DimRowDraft): { p1: Point; p2: Point; value: number } | null {
  let u: Point;
  if (r.direction === null) {
    const d = sub(r.p2, r.p1);
    const l = len(d);
    if (l < 1e-9) return null;
    u = mul(d, 1 / l);
  } else {
    const a = r.direction * Math.PI / 180;
    u = { x: Math.cos(a), y: Math.sin(a) };
  }
  const n = { x: -u.y, y: u.x };
  const signed = (r.p2.x - r.p1.x) * u.x + (r.p2.y - r.p1.y) * u.y;
  const d1 = add(r.p1, mul(n, r.offset));
  return { p1: d1, p2: add(d1, mul(u, signed)), value: Math.abs(signed) };
}

function TempDimEditor({ dim, rect, onApply, onPin, onClose, pinLabel }: {
  dim: TempDim; rect: Editing['rect']; onApply: (v: string) => void; onPin: () => void; onClose: () => void; pinLabel: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <div className="fixed z-[60] flex items-center gap-1 rounded-md border border-border bg-background p-1 shadow-lg"
      style={{ left: rect.left + rect.width / 2, top: rect.top + rect.height / 2, transform: 'translate(-50%, -50%)' }}
      onPointerDown={e => e.stopPropagation()}>
      {dim.apply && (
        <input
          ref={ref}
          data-testid="temp-dim-input"
          className="h-6 w-20 rounded border border-input bg-transparent px-1.5 text-right text-[12px] tabular-nums outline-none focus:border-[var(--color-accent)]"
          defaultValue={formatDimension(dim.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') onApply((e.target as HTMLInputElement).value);
            if (e.key === 'Escape') onClose();
            e.stopPropagation();
          }}
          onBlur={onClose}
        />
      )}
      {dim.row && (
        <button
          className="h-6 rounded px-1.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
          onPointerDown={e => e.preventDefault()}
          onClick={onPin}
          title={pinLabel}
          data-testid="temp-dim-pin"
        >
          ⊢⊣
        </button>
      )}
    </div>
  );
}

function TextNoteInput({ at, placeholder, onDone }: { at: { x: number; y: number }; placeholder: string; onDone: (text: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  // Opened on pointerdown: the click's own mousedown would steal focus, so focus after it
  useEffect(() => {
    const id = setTimeout(() => ref.current?.focus(), 30);
    return () => clearTimeout(id);
  }, []);
  const finish = (text: string) => {
    if (done.current) return;
    done.current = true;
    onDone(text);
  };
  return (
    <input
      ref={ref}
      data-testid="text-note-input"
      className="fixed z-[60] h-7 w-56 -translate-x-1/2 -translate-y-1/2 rounded-md border border-[var(--color-accent)] bg-background px-2 text-[12px] shadow-lg outline-none"
      style={{ left: at.x, top: at.y }}
      placeholder={placeholder}
      onPointerDown={e => e.stopPropagation()}
      onKeyDown={e => {
        e.stopPropagation();
        if (e.key === 'Enter') finish((e.target as HTMLInputElement).value);
        if (e.key === 'Escape') finish('');
      }}
      // Clicking away keeps typed text; an empty box stays open until Esc
      onBlur={e => { if (e.target.value.trim()) finish(e.target.value); }}
    />
  );
}
