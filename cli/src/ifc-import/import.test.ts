import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as W from 'web-ifc';
import { importIfc, IfcImportError, sniffIfc } from './index.js';
import { fixtureIfc } from './fixture.test-util.js';
import { build } from '../build/index.js';
import { readCsv } from '../utils/csv.js';

let api: W.IfcAPI;
beforeAll(async () => {
  api = new W.IfcAPI();
  await api.Init();
  api.SetLogLevel(W.LogLevel.LOG_LEVEL_OFF);
});

const enc = (s: string) => new TextEncoder().encode(s);

function writeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'bd-ifc-'));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
}

function rows(files: Record<string, string>, path: string): Record<string, string>[] {
  const dir = writeProject({ [path]: files[path] ?? '' });
  try { return readCsv(join(dir, path)).rows; } finally { rmSync(dir, { recursive: true, force: true }); }
}

function line(files: Record<string, string>, path: string, id: string): number[][] {
  const fc = JSON.parse(files[path]);
  return fc.features.find((f: { properties: { id: string } }) => f.properties.id === id).geometry.coordinates;
}

// A 6 × 4 m room (centre lines), 200 mm walls; the east wall stops at the
// inner face of the north wall and the west wall overshoots, as exports do.
const room = fixtureIfc({
  walls: [
    { from: [0, 0], to: [6000, 0], thickness: 200 },
    { from: [6000, 0], to: [6000, 3900], thickness: 200 },
    { from: [6000, 4000], to: [0, 4000], thickness: 200 },
    { from: [0, 4040], to: [0, 0], thickness: 200 },
  ],
  doors: [{ wall: 0, at: 2500, width: 900, height: 2100 }],
  slab: { x0: -100, y0: -100, x1: 6100, y1: 4100, thickness: 200 },
  spaces: [{ name: 'Office', number: '101', x0: 100, y0: 100, x1: 5900, y1: 3900 }],
});

describe('importIfc', () => {
  it('converts walls, a hosted door, a slab and a room (mm model)', () => {
    const { files, report } = importIfc(api, enc(room), { fileName: 'room.ifc' });
    expect(report.source.lengthUnitToMeter).toBeCloseTo(0.001);
    expect(report.levels).toEqual([{ id: 'lv-1', name: 'Ground Floor', elevation: 0 }]);
    expect(report.counts).toMatchObject({ wall: 4, door: 1, slab: 1, space: 1 });

    const walls = rows(files, 'lv-1/wall.csv');
    expect(walls.map(w => w.thickness)).toEqual(['0.2', '0.2', '0.2', '0.2']);
    // Free ends joined: the east wall reaches the north wall's centre line, the west overshoot is trimmed
    expect(line(files, 'lv-1/wall.geojson', 'w-2')[1]).toEqual([6, 4]);
    expect(line(files, 'lv-1/wall.geojson', 'w-4')[0]).toEqual([0, 4]);

    const [door] = rows(files, 'lv-1/door.csv');
    expect(door).toMatchObject({ host_id: 'w-1', position: '2.5', width: '0.9', height: '2.1', operation: 'single_swing' });

    const [slab] = rows(files, 'lv-1/slab.csv');
    expect(slab).toMatchObject({ function: 'floor', thickness: '0.2' });
    const ring = line(files, 'lv-1/slab.geojson', 'sl-1')[0] as unknown as number[][];
    expect(ring.length).toBe(5);

    const [space] = rows(files, 'lv-1/space.csv');
    expect(space).toMatchObject({ name: 'Office', number: '101' });
    expect(report.rooms.issues).toEqual([]);
    // Net area at the wall faces equals the IFC space outline
    expect(report.rooms.area?.compared).toBe(1);
    expect(report.rooms.area?.maxAbsPct).toBeLessThan(0.5);
  });

  it('writes a project that bimdown build accepts without issues', () => {
    const { files } = importIfc(api, enc(room));
    const dir = writeProject(files);
    try {
      const r = build(dir);
      expect(r.issues).toEqual([]);
      expect(r.roomIssues).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds a room separator where two spaces share an open edge', () => {
    const open = fixtureIfc({
      walls: [
        { from: [0, 0], to: [8000, 0], thickness: 200 },
        { from: [8000, 0], to: [8000, 4000], thickness: 200 },
        { from: [8000, 4000], to: [0, 4000], thickness: 200 },
        { from: [0, 4000], to: [0, 0], thickness: 200 },
      ],
      spaces: [
        { name: 'Living', number: '1', x0: 100, y0: 100, x1: 4000, y1: 3900 },
        { name: 'Kitchen', number: '2', x0: 4000, y0: 100, x1: 7900, y1: 3900 },
      ],
    });
    const { files, report } = importIfc(api, enc(open));
    expect(report.counts.room_separator).toBe(1);
    const sep = line(files, 'lv-1/room_separator.geojson', 'rs-1');
    // From wall centre line to wall centre line, so both rooms close
    expect(sep.map(p => p[0])).toEqual([4, 4]);
    expect(sep.map(p => p[1]).sort((a, b) => a - b)).toEqual([0, 4]);
    expect(report.rooms.issues).toEqual([]);
  });

  it('imports furniture as library pieces (skipped for a target without a furniture table)', () => {
    const furnished = fixtureIfc({
      walls: [{ from: [0, 0], to: [4000, 0], thickness: 200 }],
      furniture: [{ name: 'Desk:1600 x 800:5001', x: 2000, y: 1000, w: 800, d: 1600, h: 750 }],
    });
    const without = importIfc(api, enc(furnished), { tables: ['wall', 'level'] });
    expect(without.report.counts.furniture).toBeUndefined();
    expect(without.report.classes.find(c => c.ifcClass === 'IfcFurnishingElement')?.skipped[0]?.reason).toMatch(/furniture/);

    // The format has the furniture table now: imported by default
    const withTable = importIfc(api, enc(furnished));
    expect(withTable.report.counts.furniture).toBe(1);
    const [desk] = rows(withTable.files, 'lv-1/furniture.csv');
    // Long side 1.6 m along y: size_x is the long side, turned 90°
    expect(desk).toMatchObject({ family: 'desk', size_x: '1.6', size_y: '0.8', height: '0.75' });
    const feat = JSON.parse(withTable.files['lv-1/furniture.geojson']).features[0];
    expect(feat.geometry.coordinates).toEqual([2, 1]);
    expect(Math.abs(feat.properties.rotation)).toBe(90);
  });

  it('reports a progress sequence ending at 1', () => {
    const seen: number[] = [];
    importIfc(api, enc(room), { onProgress: p => seen.push(p.fraction) });
    expect(seen[seen.length - 1]).toBe(1);
    expect(seen.every((v, i) => i === 0 || v >= seen[i - 1])).toBe(true);
  });

  it('rejects files that are not IFC', () => {
    expect(() => sniffIfc(enc('hello world, not a model at all'))).toThrow(IfcImportError);
    expect(() => sniffIfc(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toThrow(/ifczip/i);
    expect(() => sniffIfc(enc('<?xml version="1.0"?><ifcXML></ifcXML>      '))).toThrow(/ifcXML/);
    try {
      importIfc(api, enc('ISO-10303-21;\nHEADER;\nFILE_SCHEMA((\'IFC2X3\'));\nENDSEC;\nDATA;\n#1=IFCWALL(\nENDSEC;\n'));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(IfcImportError);
      expect(['corrupt', 'empty']).toContain((e as IfcImportError).code);
    }
  });
});
