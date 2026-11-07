import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseUnderlayCsv, serializeUnderlayCsv, nextUnderlayId, underlayFileName } from './csv.ts';
import { calibrate, localToWorld, worldToLocal, rotateAbout, sweepDeg, placeInView, normalizeDeg } from './transform.ts';
import { decodeDxf, parseDxf, plainMtext } from './dxf.ts';
import { dxfUnitToMeters } from './dxfUnits.ts';
import { SegmentIndex } from './snapIndex.ts';
import { UnderlayStore, UnderlayImportError } from './store.ts';
import { underlayKind, type Underlay } from './types.ts';
import { computeSnap, setUnderlaySnapProvider } from '../utils/snap.ts';
import { createMemoryDataSource } from '../dataSources/memory.ts';

const fixture = (name: string) => {
  const b = readFileSync(join(__dirname, 'fixtures', name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

const base: Underlay = {
  id: 'ul-1', name: 'Plan, ground', levelId: 'lv-1', file: 'underlays/plan.png', page: 1,
  x: 1.5, y: -2, rotation: 30, scale: 0.02, opacity: 0.5, visible: true, locked: false, hiddenLayers: [],
};

describe('underlay csv', () => {
  it('round-trips rows, quoting names and joining hidden layers', () => {
    const rows: Underlay[] = [base, { ...base, id: 'ul-2', file: 'underlays/a.dxf', visible: false, locked: true, hiddenLayers: ['DIM', 'A-TEXT'] }];
    const text = serializeUnderlayCsv(rows);
    expect(text.split('\n')[0]).toBe('id,name,level_id,file,page,x,y,rotation,scale,opacity,visible,locked,hidden_layers');
    expect(text).toContain('"Plan, ground"');
    expect(parseUnderlayCsv(text)).toEqual(rows);
  });

  it('fills defaults and drops incomplete rows', () => {
    const text = 'id,level_id,file\nul-1,lv-1,underlays/a.png\nul-2,,underlays/b.png\n';
    expect(parseUnderlayCsv(text)).toEqual([{
      id: 'ul-1', name: '', levelId: 'lv-1', file: 'underlays/a.png', page: 1, x: 0, y: 0, rotation: 0,
      scale: 1, opacity: 0.5, visible: true, locked: false, hiddenLayers: [],
    }]);
  });

  it('picks free ids and file names', () => {
    expect(nextUnderlayId([base, { ...base, id: 'ul-2' }])).toBe('ul-3');
    expect(underlayFileName('Ground Floor (rev 2).PNG', new Set())).toBe('underlays/Ground-Floor-rev-2.png');
    expect(underlayFileName('首层平面.dxf', new Set(['underlays/首层平面.dxf']))).toBe('underlays/首层平面-2.dxf');
  });

  it('knows the supported kinds', () => {
    expect(underlayKind('underlays/a.JPG')).toBe('image');
    expect(underlayKind('underlays/a.pdf')).toBe('pdf');
    expect(underlayKind('underlays/a.dxf')).toBe('dxf');
    expect(underlayKind('underlays/a.dwg')).toBeNull();
  });
});

describe('underlay transform', () => {
  const close = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    expect(a.x).toBeCloseTo(b.x, 9);
    expect(a.y).toBeCloseTo(b.y, 9);
  };

  it('local ↔ world are inverse', () => {
    const p = { x: 120, y: -40 };
    close(worldToLocal(base, localToWorld(base, p)), p);
  });

  it('calibration scales about the first point', () => {
    const u = { x: 0, y: 0, rotation: 0, scale: 0.01 };
    // Points 100 px apart measure 1 m; they are really 5 m apart.
    const p1 = localToWorld(u, { x: 50, y: 50 }), p2 = localToWorld(u, { x: 150, y: 50 });
    const next = calibrate(u, p1, p2, 5)!;
    expect(next.scale).toBeCloseTo(0.05);
    close(localToWorld(next, { x: 50, y: 50 }), p1);
    const q2 = localToWorld(next, { x: 150, y: 50 });
    expect(Math.hypot(q2.x - p1.x, q2.y - p1.y)).toBeCloseTo(5);
    expect(calibrate(u, p1, p1, 5)).toBeNull();
    expect(calibrate(u, p1, p2, 0)).toBeNull();
  });

  it('rotation about a point keeps that point fixed', () => {
    const center = localToWorld(base, { x: 10, y: 10 });
    const next = rotateAbout(base, center, 45);
    expect(next.rotation).toBeCloseTo(75);
    close(localToWorld(next, { x: 10, y: 10 }), center);
    expect(sweepDeg({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(90);
    expect(normalizeDeg(270)).toBe(-90);
    expect(normalizeDeg(-180)).toBe(180);
  });

  it('places local bounds centered in a view', () => {
    const p = placeInView({ minX: 0, minY: 0, maxX: 1000, maxY: 500 }, { minX: 0, minY: 0, maxX: 20, maxY: 20 });
    expect(p.scale).toBeCloseTo(0.016);
    close(localToWorld(p, { x: 500, y: 250 }), { x: 10, y: 10 });
  });
});

describe('DXF', () => {
  const drawing = parseDxf(decodeDxf(fixture('small.dxf')));

  it('reads layers with colors and the off flag', () => {
    const byName = Object.fromEntries(drawing.layers.map(l => [l.name, l]));
    expect(byName.WALL.color).toBe('#ff0000');
    expect(byName.HIDDEN.offInFile).toBe(true);
    expect(byName.WALL.offInFile).toBe(false);
    expect(drawing.insUnits).toBe(4);
    expect(dxfUnitToMeters(drawing.insUnits, drawing.bounds)).toBe(0.001);
  });

  it('tessellates bulges and arcs, flattens rotated/scaled block inserts', () => {
    const walls = drawing.polylines.get('WALL')!;
    const abs = (pl: number[]) => pl.map((v, i) => v + (i % 2 ? drawing.origin.y : drawing.origin.x));
    // The bulge-1 polyline is a semicircle from (0,0) to (1000,0) dipping to y = -500
    const semi = walls.map(abs).find(pl => pl.length > 6 && Math.min(...pl.filter((_, i) => i % 2)) < -499)!;
    expect(semi).toBeTruthy();
    expect(semi[semi.length - 2]).toBeCloseTo(1000, 6);
    // BOX (100 × 50) at (3000, 1000), rotated 90°, scaled 2 → spans x 2900..3000, y 1000..1200
    const box = walls.map(abs).find(pl => pl.length === 10)!;
    const xs = box.filter((_, i) => i % 2 === 0), ys = box.filter((_, i) => i % 2 === 1);
    expect(Math.min(...xs)).toBeCloseTo(2900, 6);
    expect(Math.max(...xs)).toBeCloseTo(3000, 6);
    expect(Math.max(...ys)).toBeCloseTo(1200, 6);
  });

  it('keeps TEXT and multi-line MTEXT', () => {
    const texts = drawing.texts.map(t => t.text);
    expect(texts).toContain('Room');
    expect(texts).toEqual(expect.arrayContaining(['A', 'B']));
    expect(plainMtext('{\\fArial|b1;Hello}\\PWorld %%c50')).toBe('Hello\nWorld ⌀50');
  });

  it('decodes legacy code-page files', () => {
    const gbk = new Uint8Array([0xca, 0xd7, 0xb2, 0xe3]); // "首层" in GBK
    const head = new TextEncoder().encode('0\nSECTION\n2\nHEADER\n9\n$DWGCODEPAGE\n3\nANSI_936\n0\nENDSEC\n999\n');
    const bytes = new Uint8Array([...head, ...gbk]);
    expect(decodeDxf(bytes.buffer).endsWith('首层')).toBe(true);
  });
});

describe('segment index', () => {
  it('finds vertices, edge points and midpoints near the cursor', () => {
    const idx = new SegmentIndex(new Float64Array([0, 0, 10, 0, 10, 0, 10, 10, 100, 100, 200, 100]));
    const hits = idx.query({ x: 9.9, y: 0.05 }, 0.2);
    expect(hits.some(h => h.type === 'endpoint' && h.x === 10 && h.y === 0)).toBe(true);
    expect(hits.some(h => h.type === 'edge')).toBe(true);
    expect(idx.query({ x: 5, y: 0.1 }, 0.2).some(h => h.type === 'midpoint' && h.x === 5)).toBe(true);
    expect(idx.query({ x: 50, y: 50 }, 0.2)).toEqual([]);
  });
});

describe('snap engine with underlay targets', () => {
  afterEach(() => setUnderlaySnapProvider(null));

  it('snaps to provider vertices unless the underlay toggle is off', () => {
    const idx = new SegmentIndex(new Float64Array([0, 0, 4, 0]));
    setUnderlaySnapProvider((p, r) => idx.query(p, r));
    const r = computeSnap({ x: 3.97, y: 0.03 }, 0.01, new Map());
    expect(r.point).toEqual({ x: 4, y: 0 });
    const off = computeSnap({ x: 3.97, y: 0.03 }, 0.01, new Map(), new Set(), undefined, 45, undefined, undefined, undefined, 'm', new Set(['underlay']));
    expect(off.point).toEqual({ x: 3.97, y: 0.03 });
  });

  it('takes the nearest vertex whole instead of mixing axes of two', () => {
    // Outer and inner face corners of a double-line wall, 0.24 apart
    const idx = new SegmentIndex(new Float64Array([0, 0, 5, 0, 0.24, 0.24, 5, 0.24]));
    setUnderlaySnapProvider((p, r) => idx.query(p, r));
    // X is nearer the inner corner, Y nearer the outer one; the outer corner is nearer in 2D
    const r = computeSnap({ x: 0.13, y: 0.1 }, 0.02, new Map());
    expect(r.point).toEqual({ x: 0, y: 0 });
  });

  it('round-length snapping from the anchor does not pull a vertex snap off its vertex', () => {
    const idx = new SegmentIndex(new Float64Array([7.2, 0, 7.2, 3]));
    setUnderlaySnapProvider((p, r) => idx.query(p, r));
    // Zoomed out (0.05 m/px): round lengths would pull 7.2 → 7.0 from the anchor at the origin
    const r = computeSnap({ x: 7.25, y: 0.02 }, 0.05, new Map(), new Set(), { x: 0, y: 0 });
    expect(r.point).toEqual({ x: 7.2, y: 0 });
  });
});

describe('underlay store', () => {
  it('imports a DXF, persists the row and file, calibrates, moves and deletes', async () => {
    const mem = createMemoryDataSource(new Map([['global/level.csv', 'id,number,name,elevation\nlv-1,1,L1,0\n']]));
    const store = new UnderlayStore(mem.dataSource);
    store.setLevel('lv-1');
    store.setUnit('m');
    store.setViewport(() => ({ minX: 0, minY: 0, maxX: 20, maxY: 20 }));
    const bytes = fixture('small.dxf');
    const u = await store.importFile(new File([bytes], 'Small Plan.dxf'));
    expect(u.file).toBe('underlays/Small-Plan.dxf');
    expect(u.scale).toBeCloseTo(0.001); // mm drawing in a metre project
    expect(u.hiddenLayers).toEqual(['HIDDEN']);
    const files = mem.getFiles();
    expect(files.get('underlays/Small-Plan.dxf')).toBeInstanceOf(ArrayBuffer);
    expect(parseUnderlayCsv(files.get('global/underlay.csv') as string)).toEqual([u]);

    // Snaps to the DXF line (0,0)-(1000,0) mm as placed
    const corner = localToWorld(u, { x: 1000, y: 0 });
    const hits = store.snapTargets({ x: corner.x + 0.001, y: corner.y }, 0.05);
    expect(hits.some(h => h.type === 'endpoint' && Math.abs(h.x - corner.x) < 1e-9)).toBe(true);

    // Calibrate: the 1000-unit line is really 2 m
    store.startMode('calibrate', u.id);
    const p0 = localToWorld(u, { x: 0, y: 0 });
    expect(store.click(p0)).toBe(false);
    expect(store.click(corner)).toBe(true);
    expect(store.applyCalibration(2)).toBe(true);
    let cur = store.getSnapshot().underlays[0];
    expect(cur.scale).toBeCloseTo(0.002);

    // Move by (+1, +2)
    store.startMode('move', u.id);
    store.click({ x: 0, y: 0 });
    store.pointerMove({ x: 1, y: 2 });
    expect(store.displayed(cur).x).toBeCloseTo(cur.x + 1);
    store.click({ x: 1, y: 2 });
    const moved = store.getSnapshot().underlays[0];
    expect(moved.x).toBeCloseTo(cur.x + 1);
    expect(moved.y).toBeCloseTo(cur.y + 2);
    cur = moved;

    // Locked underlays don't start interactions
    store.update(u.id, { locked: true });
    store.startMode('rotate', u.id);
    expect(store.getSnapshot().mode).toBeNull();

    store.flush();
    await new Promise(r => setTimeout(r, 0));
    expect(parseUnderlayCsv(mem.getFiles().get('global/underlay.csv') as string)[0].locked).toBe(true);

    store.remove(u.id);
    await new Promise(r => setTimeout(r, 0));
    expect(mem.getFiles().has('underlays/Small-Plan.dxf')).toBe(false);
    expect(mem.getFiles().has('global/underlay.csv')).toBe(false);
    store.dispose();
  });

  it('rejects unsupported files and read-only sources', async () => {
    const mem = createMemoryDataSource();
    const store = new UnderlayStore(mem.dataSource);
    store.setLevel('lv-1');
    await expect(store.importFile(new File(['x'], 'a.dwg'))).rejects.toBeInstanceOf(UnderlayImportError);
    const ro = new UnderlayStore({ ...mem.dataSource, saveBinary: undefined });
    ro.setLevel('lv-1');
    await expect(ro.importFile(new File(['x'], 'a.png'))).rejects.toMatchObject({ reason: 'read_only' });
  });

  it('loads rows from global/underlay.csv and prunes deleted levels', async () => {
    const mem = createMemoryDataSource(new Map<string, string | ArrayBuffer>([
      ['global/underlay.csv', serializeUnderlayCsv([base, { ...base, id: 'ul-2', levelId: 'lv-2' }])],
    ]));
    const store = new UnderlayStore(mem.dataSource);
    await store.load();
    expect(store.getSnapshot().underlays.map(u => u.id)).toEqual(['ul-1', 'ul-2']);
    store.pruneLevels(new Set(['lv-1']));
    expect(store.getSnapshot().underlays.map(u => u.id)).toEqual(['ul-1']);
  });
});
