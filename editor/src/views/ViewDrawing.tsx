/**
 * 2D drawing mode of the elevation / section pane: the view's vector drawing
 * (cut poché, lines beyond, levels, grids — export/drawing/section.ts) at a
 * print scale, with its own annotations: linear dimensions (click start, end,
 * then where the dimension line goes) and text notes, stored in
 * global/dimension.csv / global/text_note.csv with `view_id` and view
 * coordinates (x along the view, y = elevation). Select one and press Delete
 * to remove it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import type { CanonicalElement, Point } from '../model/elements.ts';
import type { LayerData } from '../types.ts';
import { collectViewSource, renderView, viewAnnotationElements, type ViewRef } from '../export/drawing/section.ts';
import { annotationItems } from '../export/annotationExport.ts';
import { itemsBounds, paperMm } from '../export/drawing/plan.ts';
import { drawingLang } from '../export/drawing/labels.ts';
import type { DrawingLayer } from '../export/drawing/layers.ts';
import { DrawingItemsSvg } from '../sheets/DrawingSvg.tsx';
import { cn } from '../lib/utils';

type Tool = 'select' | 'dimension' | 'text';
const SCALES = [50, 100, 200, 500];
const BTN = 'flex h-6 cursor-pointer items-center rounded-md border-none bg-transparent px-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground';
const ON = 'bg-[var(--accent-dim)] text-[var(--color-accent)]';

const fmt = (n: number) => String(Number(n.toFixed(4)));

function nextId(prefix: string, layers: LayerData[]): string {
  const used = new Set(layers.flatMap(l => [...l.csvRows.keys()]));
  let n = 1;
  while (used.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

/** Add / remove a row of a view annotation table (immutably). */
function withRow(layers: LayerData[], table: string, id: string, row: Record<string, string> | null): LayerData[] {
  const out = layers.map(l => ({ ...l, csvRows: new Map(l.csvRows) }));
  let layer = out.find(l => l.tableName === table);
  if (!layer) out.push(layer = { tableName: table, discipline: 'annotation', geojsonContent: '', csvRows: new Map() });
  if (row) layer.csvRows.set(id, { id, ...row });
  else layer.csvRows.delete(id);
  return out;
}

export default function ViewDrawing({ view }: { view: ViewRef }) {
  const { t, i18n } = useTranslation();
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const project = state.project!;
  const lang = drawingLang(i18n.language);
  const [scale, setScale] = useState(100);
  const [hidden, setHidden] = useState(false);
  const [tool, setTool] = useState<Tool>('select');
  const [pts, setPts] = useState<Point[]>([]);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [cam, setCam] = useState({ zoom: 1, x: 0, y: 0 });

  // Model meshes: rebuilt when the model changes, not when annotations do
  const src = useMemo(() => collectViewSource({
    project, grids: state.grids,
    live: state.document ? { levelId: state.document.levelId, elements: state.document.elements.values() } : undefined,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [project.floors, project.globalLayers, project.levels, project.sections, project.types, state.grids, state.document, state.documentVersion]);
  const drawing = useMemo(() => renderView(src, view, scale, { hidden, lang, annotations: false }), [src, view.kind, view.id, scale, hidden, lang]); // eslint-disable-line react-hooks/exhaustive-deps

  const own = useMemo(() => viewAnnotationElements(project).filter(a => a.attrs.view_id === view.id), [project, view.id]);
  const annoLayers = useMemo(() => new Map<string, DrawingLayer>(), []);
  const annos = useMemo(() => own.map(el => ({ el, items: annotationItems([el], src.unit, scale, def => { annoLayers.set(def.name, def); return def.name; }) })), [own, src.unit, scale, annoLayers]);

  const pm = paperMm(src.unit, scale);
  const box = drawing?.bounds ?? { minX: 0, minY: 0, maxX: 10, maxY: 10 };

  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const w = box.maxX - box.minX || 1, h = box.maxY - box.minY || 1;
    const zoom = Math.min((width - 40) / w, (height - 40) / h);
    setCam({ zoom, x: (width - w * zoom) / 2 - box.minX * zoom, y: (height + h * zoom) / 2 + box.minY * zoom });
  }, [box.minX, box.minY, box.maxX, box.maxY]);
  useEffect(() => { fit(); }, [view.kind, view.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onFit = () => fit();
    window.addEventListener('zoom-to-fit-view', onFit);
    return () => window.removeEventListener('zoom-to-fit-view', onFit);
  }, [fit]);

  /** Screen → drawing (x along the view, y = elevation). */
  const toModel = (cx: number, cy: number): Point => {
    const r = ref.current!.getBoundingClientRect();
    return { x: (cx - r.left - cam.x) / cam.zoom, y: (cam.y - (cy - r.top)) / cam.zoom };
  };

  /** Snap to the nearest line end of the drawing within 8 px. */
  const vertices = useMemo(() => {
    const out: Point[] = [];
    for (const it of drawing?.items ?? []) if (it.kind === 'path') out.push(...it.pts);
    return out;
  }, [drawing]);
  const snap = (p: Point): Point => {
    const tol = 8 / cam.zoom;
    let best: Point | null = null, bd = tol;
    for (const v of vertices) {
      const d = Math.hypot(v.x - p.x, v.y - p.y);
      if (d < bd) { bd = d; best = v; }
    }
    return best ?? p;
  };

  const updateLayers = (layers: LayerData[]) => dispatch({ type: 'UPDATE_VIEW_ANNOTATIONS', layers, persist: true });

  const click = (e: React.PointerEvent) => {
    if (state.readonly) return;
    const p = snap(toModel(e.clientX, e.clientY));
    const layers = project.viewAnnotations ?? [];
    if (tool === 'text') {
      const text = window.prompt(t('views.textPrompt'));
      if (text && text.trim()) {
        updateLayers(withRow(layers, 'text_note', nextId('tx', layers), {
          x: fmt(p.x), y: fmt(p.y), text: text.trim(), size: '', paper_size: '2.5', rotation: '0', view_id: view.id,
        }));
      }
      setTool('select');
      return;
    }
    if (tool === 'dimension') {
      const next = [...pts, pts.length === 2 ? toModel(e.clientX, e.clientY) : p];
      if (next.length < 3) { setPts(next); return; }
      const [a, b, c] = next;
      const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
      // Offset along the left normal of the measuring direction (0° → +y, 90° → −x)
      const offset = horizontal ? c.y - a.y : a.x - c.x;
      updateLayers(withRow(layers, 'dimension', nextId('dm', layers), {
        start_x: fmt(a.x), start_y: fmt(a.y), end_x: fmt(b.x), end_y: fmt(b.y), start_ref: '', end_ref: '',
        direction: horizontal ? '0' : '90', offset: fmt(offset), text: '', view_id: view.id,
      }));
      setPts([]);
      return;
    }
    // Select: the annotation whose extent contains the click
    const tol = 4 / cam.zoom;
    const hit = annos.find(a => {
      const b = itemsBounds(a.items);
      return b && p.x >= b.minX - tol && p.x <= b.maxX + tol && p.y >= b.minY - tol && p.y <= b.maxY + tol;
    });
    setSelected(hit?.el.id ?? null);
  };

  const remove = (el: CanonicalElement) => {
    updateLayers(withRow(project.viewAnnotations ?? [], el.tableName, el.id, null));
    setSelected(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      if (e.key === 'Escape') { setPts([]); setTool('select'); setSelected(null); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !state.readonly) {
        const el = own.find(a => a.id === selected);
        if (el) { e.preventDefault(); e.stopPropagation(); remove(el); }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // Pan (drag the background) and zoom (wheel)
  const pan = useRef<{ sx: number; sy: number; x: number; y: number; moved: boolean } | null>(null);
  const onWheel = (e: React.WheelEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const k = Math.exp(-e.deltaY * 0.0015);
    const zoom = Math.max(0.5, Math.min(5000, cam.zoom * k));
    const px = e.clientX - r.left, py = e.clientY - r.top;
    setCam({ zoom, x: px - (px - cam.x) * (zoom / cam.zoom), y: py - (py - cam.y) * (zoom / cam.zoom) });
  };

  const preview = (() => {
    if (tool !== 'dimension' || !cursor || pts.length === 0) return null;
    const a = pts[0], b = pts[1] ?? cursor;
    return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#3a7bff" strokeWidth={1.5 / cam.zoom} strokeDasharray={`${4 / cam.zoom} ${3 / cam.zoom}`} />;
  })();

  const sel = annos.find(a => a.el.id === selected);
  const selBox = sel ? itemsBounds(sel.items) : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--panel-border)] px-2 py-1">
        <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
          {t('views.drawingScale')}
          <select className="h-6 rounded-md border border-border bg-[var(--bg-input)] px-1 text-[11px]" value={scale} data-testid="view-drawing-scale"
            onChange={e => setScale(parseInt(e.target.value, 10))}>
            {SCALES.map(s => <option key={s} value={s}>1:{s}</option>)}
          </select>
        </label>
        <label className="flex cursor-pointer items-center gap-1 text-[10px] text-muted-foreground">
          <input type="checkbox" checked={hidden} onChange={e => setHidden(e.target.checked)} data-testid="view-hidden-lines" />
          {t('views.hiddenLines')}
        </label>
        {!state.readonly && (
          <div className="ml-2 flex items-center gap-0.5">
            <button className={cn(BTN, tool === 'dimension' && ON)} title={t('views.addDimension')} data-testid="view-tool-dimension"
              onClick={() => { setTool(tool === 'dimension' ? 'select' : 'dimension'); setPts([]); }}>↔ {t('annot.dimension')}</button>
            <button className={cn(BTN, tool === 'text' && ON)} title={t('views.addText')} data-testid="view-tool-text"
              onClick={() => setTool(tool === 'text' ? 'select' : 'text')}>T {t('views.textPrompt')}</button>
            {sel && <button className={cn(BTN, 'text-destructive')} title={t('views.deleteAnnotation')} onClick={() => remove(sel.el)} data-testid="view-anno-delete">✕</button>}
          </div>
        )}
        <span className="ml-auto truncate text-[10px] text-muted-foreground">
          {tool === 'dimension' ? t('views.addDimension') : tool === 'text' ? t('views.addText') : own.length ? t('views.drawingHint') : ''}
        </span>
      </div>
      <div ref={ref} className={cn('relative min-h-0 flex-1 overflow-hidden bg-white', tool !== 'select' && 'cursor-crosshair')} data-testid="view-drawing"
        data-cam={`${cam.zoom},${cam.x},${cam.y}`}
        onWheel={onWheel}
        onPointerDown={e => { if (e.button !== 0) return; pan.current = { sx: e.clientX, sy: e.clientY, x: cam.x, y: cam.y, moved: false }; (e.currentTarget as Element).setPointerCapture(e.pointerId); }}
        onPointerMove={e => {
          setCursor(snap(toModel(e.clientX, e.clientY)));
          const g = pan.current;
          if (!g) return;
          const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
          if (Math.hypot(dx, dy) > 3) g.moved = true;
          if (g.moved && tool === 'select') setCam(c => ({ ...c, x: g.x + dx, y: g.y + dy }));
        }}
        onPointerUp={e => { const g = pan.current; pan.current = null; if (g && !g.moved) click(e); }}>
        <svg width="100%" height="100%" className="block select-none">
          <g transform={`translate(${cam.x},${cam.y}) scale(${cam.zoom},${-cam.zoom})`}>
            {drawing && <DrawingItemsSvg items={drawing.items} layers={drawing.layers} pm={pm} />}
            {annos.map(a => <DrawingItemsSvg key={a.el.id} items={a.items} layers={annoLayers} pm={pm} />)}
            {selBox && (
              <rect x={selBox.minX - 3 / cam.zoom} y={selBox.minY - 3 / cam.zoom} width={selBox.maxX - selBox.minX + 6 / cam.zoom} height={selBox.maxY - selBox.minY + 6 / cam.zoom}
                fill="rgba(58,123,255,0.08)" stroke="#3a7bff" strokeWidth={1 / cam.zoom} />
            )}
            {preview}
            {tool !== 'select' && cursor && <circle cx={cursor.x} cy={cursor.y} r={3 / cam.zoom} fill="none" stroke="#3a7bff" strokeWidth={1.2 / cam.zoom} />}
          </g>
        </svg>
      </div>
    </div>
  );
}
