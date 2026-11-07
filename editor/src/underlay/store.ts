// Underlay state outside the editor reducer: the rows of global/underlay.csv,
// decoded assets (image URLs, rendered PDF pages, parsed DXF), the selected
// underlay and the active place/calibrate/rotate interaction. Every committed
// change is written back through the DataSource.

import type { Point } from '../model/elements.ts';
import type { DataSource } from '../utils/dataSource.ts';
import { fetchBinaryFile } from '../utils/dataSource.ts';
import type { ProjectUnit } from '../types.ts';
import type { ExternalSnapTarget } from '../utils/snap.ts';
import { IMAGE_MIME, MAX_UNDERLAY_BYTES, UNDERLAY_CSV, underlayKind, type Underlay, type UnderlayKind } from './types.ts';
import { nextUnderlayId, parseUnderlayCsv, serializeUnderlayCsv, underlayFileName } from './csv.ts';
import { calibrate, localToWorld, moveBy, placeInView, rotateAbout, sweepDeg, type Bounds } from './transform.ts';
import type { DxfDrawing } from './dxf.ts';
import { dxfUnitToMeters } from './dxfUnits.ts';
import { SegmentIndex } from './snapIndex.ts';

export type AssetState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; kind: 'image' | 'pdf'; url: string; width: number; height: number; pageCount?: number }
  | { status: 'ready'; kind: 'dxf'; drawing: DxfDrawing };

export type UnderlayMode =
  | { kind: 'calibrate'; id: string; points: Point[] }
  | { kind: 'move'; id: string; base: Point | null }
  | { kind: 'rotate'; id: string; center: Point | null; ref: Point | null };

export interface PendingCalibration { id: string; p1: Point; p2: Point }

export interface UnderlaySnapshot {
  underlays: readonly Underlay[];
  /** Keyed by assetKey(underlay) */
  assets: ReadonlyMap<string, AssetState>;
  selectedId: string | null;
  mode: UnderlayMode | null;
  cursor: Point | null;
  calibration: PendingCalibration | null;
  importing: boolean;
}

export type ImportError = 'unsupported' | 'too_large' | 'read_only' | 'failed';

export class UnderlayImportError extends Error {
  readonly reason: ImportError;
  constructor(reason: ImportError, detail?: string) {
    super(detail ?? reason);
    this.reason = reason;
  }
}

/** Image/PDF assets are per page; DXF and images per file. */
export function assetKey(u: Pick<Underlay, 'file' | 'page'>): string {
  return underlayKind(u.file) === 'pdf' ? `${u.file}#${u.page}` : u.file;
}

// global/underlay.csv written by someone else (an AI agent, another tab):
// useLiveProject reports it here and every mounted store reloads.
const csvListeners = new Set<() => void>();

export function notifyUnderlayCsvChanged(): void {
  for (const fn of csvListeners) fn();
}

export function onUnderlayCsvChanged(fn: () => void): () => void {
  csvListeners.add(fn);
  return () => csvListeners.delete(fn);
}

const UNIT_TO_M: Record<ProjectUnit, number> = { m: 1, mm: 0.001, ft: 0.3048, in: 0.0254 };
const PERSIST_DELAY_MS = 250;

/** Local-coordinate bounds of a ready asset (raster: bottom-left origin). */
export function localBounds(asset: AssetState): Bounds | null {
  if (asset.status !== 'ready') return null;
  if (asset.kind === 'dxf') return asset.drawing.bounds;
  return { minX: 0, minY: 0, maxX: asset.width, maxY: asset.height };
}

async function imageSize(url: string): Promise<{ width: number; height: number }> {
  const img = new Image();
  img.src = url;
  await img.decode();
  return { width: img.naturalWidth, height: img.naturalHeight };
}

export class UnderlayStore {
  private ds: DataSource;
  private readonly isReadonly: boolean;
  private snap: UnderlaySnapshot = {
    underlays: [], assets: new Map(), selectedId: null, mode: null, cursor: null, calibration: null, importing: false,
  };
  private readonly listeners = new Set<() => void>();
  private readonly bytes = new Map<string, ArrayBuffer>(); // PDF sources, to render other pages
  private readonly indexes = new Map<string, { sig: string; index: SegmentIndex | null }>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private loadToken = 0;
  private disposed = false;
  /** Mounted providers using this store (see UnderlayProvider). */
  private attached = 0;
  levelId = '';
  private unit: ProjectUnit = 'm';
  /** Visible plan rectangle, supplied by the 2D canvas (for placing imports). */
  private viewport: (() => Bounds | null) | null = null;

  constructor(ds: DataSource, isReadonly = false) {
    this.ds = ds;
    this.isReadonly = isReadonly;
  }

  // ── subscription ──

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): UnderlaySnapshot => this.snap;

  private set(patch: Partial<UnderlaySnapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }

  get canEdit(): boolean {
    return !this.isReadonly && typeof this.ds.saveBinary === 'function';
  }

  setUnit(unit: ProjectUnit) {
    this.unit = unit;
  }

  setViewport(fn: (() => Bounds | null) | null) {
    this.viewport = fn;
  }

  /** A provider mounted with this store. */
  attach() {
    this.attached++;
  }

  /** A provider unmounted; dispose unless re-attached right away (StrictMode re-runs effects). */
  detach() {
    this.flush();
    this.attached--;
    setTimeout(() => { if (this.attached === 0) this.dispose(); }, 0);
  }

  dispose() {
    this.disposed = true;
    this.flush();
    for (const a of this.snap.assets.values()) {
      if (a.status === 'ready' && a.kind !== 'dxf') URL.revokeObjectURL(a.url);
    }
    this.listeners.clear();
  }

  // ── loading ──

  async load(): Promise<void> {
    const token = ++this.loadToken;
    const text = await this.ds.fetchText(UNDERLAY_CSV).catch(() => null);
    if (token !== this.loadToken || this.disposed) return;
    const underlays = parseUnderlayCsv(text);
    const selectedId = underlays.some(u => u.id === this.snap.selectedId) ? this.snap.selectedId : null;
    this.set({ underlays, selectedId });
    this.ensureAssets();
  }

  setLevel(levelId: string) {
    if (levelId === this.levelId) return;
    this.levelId = levelId;
    if (this.snap.mode) this.cancelMode();
    const sel = this.snap.underlays.find(u => u.id === this.snap.selectedId);
    if (sel && sel.levelId !== levelId) this.set({ selectedId: null });
    this.ensureAssets();
  }

  /** Drop underlays whose level was deleted. */
  pruneLevels(levelIds: ReadonlySet<string>) {
    if (this.isReadonly || levelIds.size === 0) return;
    const gone = this.snap.underlays.filter(u => !levelIds.has(u.levelId));
    for (const u of gone) this.remove(u.id);
  }

  /** Load assets for the current level's underlays (lazily, once). */
  private ensureAssets() {
    for (const u of this.snap.underlays) {
      if (u.levelId !== this.levelId) continue;
      const key = assetKey(u);
      if (this.snap.assets.has(key)) continue;
      void this.loadAsset(u);
    }
  }

  private setAsset(key: string, state: AssetState) {
    const assets = new Map(this.snap.assets);
    const prev = assets.get(key);
    if (prev?.status === 'ready' && prev.kind !== 'dxf' && (state.status !== 'ready' || state.kind === 'dxf' || state.url !== prev.url)) {
      URL.revokeObjectURL(prev.url);
    }
    assets.set(key, state);
    this.set({ assets });
  }

  private async loadAsset(u: Underlay, preloaded?: ArrayBuffer): Promise<AssetState> {
    const key = assetKey(u);
    this.setAsset(key, { status: 'loading' });
    let state: AssetState;
    try {
      const data = preloaded ?? this.bytes.get(u.file) ?? await fetchBinaryFile(this.ds, u.file);
      if (!data) throw new Error('File not found');
      state = await this.decode(u, data);
    } catch (e) {
      state = { status: 'error', message: (e as Error)?.message || 'Could not read the file' };
    }
    if (!this.disposed) this.setAsset(key, state);
    return state;
  }

  private async decode(u: Pick<Underlay, 'file' | 'page'>, data: ArrayBuffer): Promise<AssetState> {
    const kind = underlayKind(u.file);
    if (kind === 'dxf') {
      const { decodeDxf, parseDxf } = await import('./dxf.ts');
      return { status: 'ready', kind, drawing: parseDxf(decodeDxf(data)) };
    }
    if (kind === 'pdf') {
      this.bytes.set(u.file, data);
      const { renderPdfPage } = await import('./pdf.ts');
      const page = await renderPdfPage(data, u.page);
      return { status: 'ready', kind, url: page.url, width: page.width, height: page.height, pageCount: page.pageCount };
    }
    if (kind === 'image') {
      const ext = u.file.slice(u.file.lastIndexOf('.')).toLowerCase();
      const url = URL.createObjectURL(new Blob([data], { type: IMAGE_MIME[ext] ?? 'image/png' }));
      try {
        const { width, height } = await imageSize(url);
        return { status: 'ready', kind, url, width, height };
      } catch (e) {
        URL.revokeObjectURL(url);
        throw e;
      }
    }
    throw new Error('Unsupported underlay type');
  }

  // ── persistence ──

  private schedulePersist() {
    if (this.isReadonly) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.flush(), PERSIST_DELAY_MS);
  }

  /** Write global/underlay.csv now if a change is pending. */
  flush() {
    if (!this.persistTimer) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
    void this.writeCsv();
  }

  private async writeCsv() {
    const list = this.snap.underlays;
    try {
      if (list.length === 0 && this.ds.deleteFile) await this.ds.deleteFile(UNDERLAY_CSV);
      else await this.ds.saveFile(UNDERLAY_CSV, serializeUnderlayCsv(list));
    } catch (err) {
      console.error('Persist underlays failed:', err);
    }
  }

  // ── import ──

  async importFile(file: File): Promise<Underlay> {
    if (!this.canEdit) throw new UnderlayImportError('read_only');
    const kind = underlayKind(file.name);
    if (!kind) throw new UnderlayImportError('unsupported');
    if (file.size > MAX_UNDERLAY_BYTES) throw new UnderlayImportError('too_large');
    if (!this.levelId) throw new UnderlayImportError('failed', 'No level');
    this.set({ importing: true });
    try {
      const data = await file.arrayBuffer();
      const taken = new Set(this.snap.underlays.map(u => u.file));
      const path = underlayFileName(file.name, taken);
      const draft = { file: path, page: 1 };
      let asset: AssetState;
      try {
        asset = await this.decode(draft, data);
      } catch (e) {
        throw new UnderlayImportError('failed', (e as Error)?.message);
      }
      const placement = this.initialPlacement(kind, asset);
      await this.ds.saveBinary!(path, data);
      const u: Underlay = {
        id: nextUnderlayId(this.snap.underlays),
        name: file.name.replace(/\.[^.]+$/, ''),
        levelId: this.levelId,
        file: path,
        page: 1,
        ...placement,
        opacity: kind === 'dxf' ? 0.8 : 0.5,
        visible: true,
        locked: false,
        hiddenLayers: asset.status === 'ready' && asset.kind === 'dxf'
          ? asset.drawing.layers.filter(l => l.offInFile).map(l => l.name)
          : [],
      };
      this.setAsset(assetKey(u), asset);
      this.set({ underlays: [...this.snap.underlays, u], selectedId: u.id });
      await this.writeCsv();
      return u;
    } finally {
      this.set({ importing: false });
    }
  }

  /** Center on the visible plan; DXF keeps its own units, rasters fill 80% of the view. */
  private initialPlacement(kind: UnderlayKind, asset: AssetState) {
    const local = localBounds(asset)!;
    const view = this.viewport?.() ?? { minX: -10, minY: -10, maxX: 10, maxY: 10 };
    if (kind === 'dxf' && asset.status === 'ready' && asset.kind === 'dxf') {
      const scale = dxfUnitToMeters(asset.drawing.insUnits, asset.drawing.bounds) / UNIT_TO_M[this.unit];
      return placeInView(local, view, scale);
    }
    return placeInView(local, view);
  }

  // ── edits ──

  update(id: string, patch: Partial<Omit<Underlay, 'id'>>) {
    const prev = this.snap.underlays.find(u => u.id === id);
    if (!prev) return;
    const next = { ...prev, ...patch };
    this.set({ underlays: this.snap.underlays.map(u => (u.id === id ? next : u)) });
    if (patch.page !== undefined && patch.page !== prev.page && !this.snap.assets.has(assetKey(next))) {
      void this.loadAsset(next);
    }
    this.schedulePersist();
  }

  /** Set the rotation, turning about the underlay's visual center. */
  setRotation(id: string, deg: number) {
    const u = this.snap.underlays.find(x => x.id === id);
    const asset = u && this.snap.assets.get(assetKey(u));
    const b = asset && localBounds(asset);
    if (!u || !b) return;
    const center = localToWorld(u, { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
    this.update(id, rotateAbout(u, center, deg - u.rotation));
  }

  remove(id: string) {
    const u = this.snap.underlays.find(x => x.id === id);
    if (!u) return;
    const underlays = this.snap.underlays.filter(x => x.id !== id);
    this.indexes.delete(id);
    this.set({
      underlays,
      selectedId: this.snap.selectedId === id ? null : this.snap.selectedId,
      mode: this.snap.mode?.id === id ? null : this.snap.mode,
      calibration: this.snap.calibration?.id === id ? null : this.snap.calibration,
    });
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    void this.writeCsv();
    if (!underlays.some(x => x.file === u.file)) {
      this.bytes.delete(u.file);
      this.ds.deleteFile?.(u.file).catch(err => console.error('Delete underlay file failed:', err));
    }
  }

  select(id: string | null) {
    if (this.snap.mode && this.snap.mode.id !== id) this.cancelMode();
    this.set({ selectedId: id });
  }

  // ── interactions (driven by tools/underlayTool.ts) ──

  startMode(kind: UnderlayMode['kind'], id: string) {
    const u = this.snap.underlays.find(x => x.id === id);
    if (!u || u.locked || this.isReadonly) return;
    const mode: UnderlayMode = kind === 'calibrate'
      ? { kind, id, points: [] }
      : kind === 'move' ? { kind, id, base: null } : { kind, id, center: null, ref: null };
    this.set({ mode, selectedId: id, cursor: null, calibration: null });
  }

  cancelMode() {
    if (this.snap.mode || this.snap.cursor) this.set({ mode: null, cursor: null });
  }

  pointerMove(p: Point) {
    if (this.snap.mode) this.set({ cursor: p });
  }

  /** A click in the active mode. Returns true when the interaction finished. */
  click(p: Point): boolean {
    const mode = this.snap.mode;
    if (!mode) return true;
    const u = this.snap.underlays.find(x => x.id === mode.id);
    if (!u) { this.cancelMode(); return true; }
    switch (mode.kind) {
      case 'calibrate': {
        const points = [...mode.points, p];
        if (points.length < 2) { this.set({ mode: { ...mode, points } }); return false; }
        if (Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) < 1e-9) return false;
        this.set({ mode: null, cursor: null, calibration: { id: u.id, p1: points[0], p2: points[1] } });
        return true;
      }
      case 'move': {
        if (!mode.base) { this.set({ mode: { ...mode, base: p } }); return false; }
        this.set({ mode: null, cursor: null });
        this.update(u.id, moveBy(u, p.x - mode.base.x, p.y - mode.base.y));
        return true;
      }
      case 'rotate': {
        if (!mode.center) { this.set({ mode: { ...mode, center: p } }); return false; }
        if (!mode.ref) {
          if (Math.hypot(p.x - mode.center.x, p.y - mode.center.y) < 1e-9) return false;
          this.set({ mode: { ...mode, ref: p } });
          return false;
        }
        this.set({ mode: null, cursor: null });
        this.update(u.id, rotateAbout(u, mode.center, sweepDeg(mode.center, mode.ref, p)));
        return true;
      }
    }
  }

  /** Apply the pending two-point calibration with the real distance. */
  applyCalibration(distance: number): boolean {
    const cal = this.snap.calibration;
    const u = cal && this.snap.underlays.find(x => x.id === cal.id);
    if (!cal || !u) return false;
    const next = calibrate(u, cal.p1, cal.p2, distance);
    if (!next) return false;
    this.set({ calibration: null });
    this.update(u.id, next);
    return true;
  }

  cancelCalibration() {
    if (this.snap.calibration) this.set({ calibration: null });
  }

  /** Placement to draw, including a live move/rotate preview. */
  displayed(u: Underlay): Underlay {
    const { mode, cursor } = this.snap;
    if (!mode || mode.id !== u.id || !cursor) return u;
    if (mode.kind === 'move' && mode.base) return { ...u, ...moveBy(u, cursor.x - mode.base.x, cursor.y - mode.base.y) };
    if (mode.kind === 'rotate' && mode.center && mode.ref) {
      return { ...u, ...rotateAbout(u, mode.center, sweepDeg(mode.center, mode.ref, cursor)) };
    }
    return u;
  }

  // ── snapping ──

  /** DXF vertices / edges near `p` on the current level's visible underlays. */
  snapTargets = (p: Point, radius: number): ExternalSnapTarget[] => {
    const out: ExternalSnapTarget[] = [];
    const { mode } = this.snap;
    // While moving/rotating, don't snap the underlay onto itself.
    const moving = mode && ((mode.kind === 'move' && mode.base) || (mode.kind === 'rotate' && mode.center)) ? mode.id : null;
    for (const u of this.snap.underlays) {
      if (u.levelId !== this.levelId || !u.visible || u.id === moving) continue;
      const index = this.indexFor(u);
      if (index) index.query(p, radius, out);
    }
    return out;
  };

  private indexFor(u: Underlay): SegmentIndex | null {
    const asset = this.snap.assets.get(assetKey(u));
    if (asset?.status !== 'ready' || asset.kind !== 'dxf') return null;
    const sig = `${u.x},${u.y},${u.rotation},${u.scale},${u.hiddenLayers.join(';')}`;
    const cached = this.indexes.get(u.id);
    if (cached && cached.sig === sig) return cached.index;
    const { drawing } = asset;
    const hidden = new Set(u.hiddenLayers);
    const segs: number[] = [];
    const ox = drawing.origin.x, oy = drawing.origin.y;
    for (const [layer, list] of drawing.polylines) {
      if (hidden.has(layer)) continue;
      for (const pl of list) {
        let prev = localToWorld(u, { x: pl[0] + ox, y: pl[1] + oy });
        for (let i = 2; i < pl.length; i += 2) {
          const cur = localToWorld(u, { x: pl[i] + ox, y: pl[i + 1] + oy });
          segs.push(prev.x, prev.y, cur.x, cur.y);
          prev = cur;
        }
      }
    }
    const index = segs.length ? new SegmentIndex(new Float64Array(segs)) : null;
    this.indexes.set(u.id, { sig, index });
    return index;
  }
}
