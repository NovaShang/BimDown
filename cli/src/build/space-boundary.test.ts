import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeSpaceBoundaries } from './space-boundary.js';
import { stringifyFeatureCollection, type BimDownFeatureCollection } from '../utils/geojson.js';

const testDir = join(__dirname, 'test-space-boundary');

function setupLevel(
  walls: { id: string; x1: number; y1: number; x2: number; y2: number }[],
  spaces: { id: string; x: number; y: number; name?: string }[],
) {
  const levelPath = join(testDir, 'lv-1');
  mkdirSync(levelPath, { recursive: true });

  if (walls.length > 0) {
    const fc: BimDownFeatureCollection = {
      type: 'FeatureCollection',
      features: walls.map((w) => ({
        type: 'Feature',
        properties: { id: w.id },
        geometry: { type: 'LineString', coordinates: [[w.x1, w.y1], [w.x2, w.y2]] },
      })),
    };
    writeFileSync(join(levelPath, 'wall.geojson'), stringifyFeatureCollection(fc));

    const csvRows = walls.map((w) => `${w.id},,0.2,concrete`).join('\n');
    writeFileSync(
      join(levelPath, 'wall.csv'),
      `id,number,thickness,material\n${csvRows}\n`,
    );
  }

  const spaceRows = spaces
    .map((s) => `${s.id},,${s.x},${s.y},${s.name ?? ''}`)
    .join('\n');
  writeFileSync(
    join(levelPath, 'space.csv'),
    `id,number,x,y,name\n${spaceRows}\n`,
  );

  return { name: 'lv-1', path: levelPath };
}

function readSpaceFc(levelPath: string): BimDownFeatureCollection {
  return JSON.parse(readFileSync(join(levelPath, 'space.geojson'), 'utf-8'));
}

describe('computeSpaceBoundaries', () => {
  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('computes boundary for a simple rectangular room', () => {
    const levelDir = setupLevel(
      [
        { id: 'w-1', x1: 0, y1: 0, x2: 10, y2: 0 },
        { id: 'w-2', x1: 10, y1: 0, x2: 10, y2: 5 },
        { id: 'w-3', x1: 10, y1: 5, x2: 0, y2: 5 },
        { id: 'w-4', x1: 0, y1: 5, x2: 0, y2: 0 },
      ],
      [{ id: 'sp-1', x: 5, y: 2.5, name: 'Room 1' }],
    );

    const result = computeSpaceBoundaries(levelDir);
    expect(result.geojsonWritten).toBe(true);
    expect(result.warnings.filter((w) => w.includes('no enclosing'))).toHaveLength(0);

    expect(existsSync(join(levelDir.path, 'space.geojson'))).toBe(true);
    const fc = readSpaceFc(levelDir.path);
    expect(fc.features.find((f) => f.properties.id === 'sp-1')).toBeDefined();
    expect(fc.features[0].geometry.type).toBe('Polygon');
  });

  it('computes boundaries for two adjacent rooms', () => {
    const levelDir = setupLevel(
      [
        { id: 'w-1', x1: 0, y1: 0, x2: 10, y2: 0 },
        { id: 'w-2', x1: 10, y1: 0, x2: 10, y2: 5 },
        { id: 'w-3', x1: 10, y1: 5, x2: 0, y2: 5 },
        { id: 'w-4', x1: 0, y1: 5, x2: 0, y2: 0 },
        { id: 'w-5', x1: 5, y1: 0, x2: 5, y2: 5 },
      ],
      [
        { id: 'sp-1', x: 2.5, y: 2.5, name: 'Room A' },
        { id: 'sp-2', x: 7.5, y: 2.5, name: 'Room B' },
      ],
    );

    const result = computeSpaceBoundaries(levelDir);
    expect(result.geojsonWritten).toBe(true);
    expect(result.warnings.filter((w) => w.includes('no enclosing'))).toHaveLength(0);

    const fc = readSpaceFc(levelDir.path);
    const ids = new Set(fc.features.map((f) => f.properties.id));
    expect(ids.has('sp-1')).toBe(true);
    expect(ids.has('sp-2')).toBe(true);
  });

  it('splits crossed walls into four rooms (+-shaped divider)', () => {
    const levelDir = setupLevel(
      [
        { id: 'w-1', x1: 0,  y1: 0,  x2: 10, y2: 0 },
        { id: 'w-2', x1: 10, y1: 0,  x2: 10, y2: 10 },
        { id: 'w-3', x1: 10, y1: 10, x2: 0,  y2: 10 },
        { id: 'w-4', x1: 0,  y1: 10, x2: 0,  y2: 0 },
        { id: 'w-h', x1: 0,  y1: 5,  x2: 10, y2: 5 },
        { id: 'w-v', x1: 5,  y1: 0,  x2: 5,  y2: 10 },
      ],
      [
        { id: 'sp-1', x: 2.5, y: 2.5, name: 'BL' },
        { id: 'sp-2', x: 7.5, y: 2.5, name: 'BR' },
        { id: 'sp-3', x: 2.5, y: 7.5, name: 'TL' },
        { id: 'sp-4', x: 7.5, y: 7.5, name: 'TR' },
      ],
    );

    const result = computeSpaceBoundaries(levelDir);
    expect(result.geojsonWritten).toBe(true);
    expect(result.warnings.filter((w) => w.includes('no enclosing'))).toHaveLength(0);

    const fc = readSpaceFc(levelDir.path);
    const ids = new Set(fc.features.map((f) => f.properties.id));
    for (const id of ['sp-1', 'sp-2', 'sp-3', 'sp-4']) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it('warns when seed point has no enclosing boundary', () => {
    const levelDir = setupLevel(
      [
        { id: 'w-1', x1: 0, y1: 0, x2: 10, y2: 0 },
        { id: 'w-2', x1: 10, y1: 0, x2: 10, y2: 5 },
        { id: 'w-3', x1: 10, y1: 5, x2: 0, y2: 5 },
        { id: 'w-4', x1: 0, y1: 5, x2: 0, y2: 0 },
      ],
      [{ id: 'sp-1', x: 20, y: 20 }],
    );

    const result = computeSpaceBoundaries(levelDir);
    expect(result.warnings.some((w) => w.includes('no enclosing boundary'))).toBe(true);
  });

  it('handles walls with gap (dangling endpoints)', () => {
    const levelDir = setupLevel(
      [
        { id: 'w-1', x1: 0, y1: 0, x2: 10, y2: 0 },
        { id: 'w-2', x1: 10, y1: 0, x2: 10, y2: 5 },
        { id: 'w-3', x1: 10, y1: 5, x2: 0, y2: 5 },
      ],
      [{ id: 'sp-1', x: 5, y: 2.5 }],
    );

    const result = computeSpaceBoundaries(levelDir);
    expect(result.warnings.some((w) => w.includes('no connected line element'))).toBe(true);
  });

  it('merges endpoints within tolerance', () => {
    const levelDir = setupLevel(
      [
        { id: 'w-1', x1: 0, y1: 0, x2: 10, y2: 0 },
        { id: 'w-2', x1: 10.005, y1: 0.003, x2: 10, y2: 5 },
        { id: 'w-3', x1: 10, y1: 5, x2: 0, y2: 5 },
        { id: 'w-4', x1: 0.002, y1: 4.998, x2: 0, y2: 0 },
      ],
      [{ id: 'sp-1', x: 5, y: 2.5 }],
    );

    const result = computeSpaceBoundaries(levelDir);
    expect(result.geojsonWritten).toBe(true);
    expect(result.warnings.filter((w) => w.includes('no enclosing'))).toHaveLength(0);
  });

  it('is idempotent - running twice produces same result', () => {
    const levelDir = setupLevel(
      [
        { id: 'w-1', x1: 0, y1: 0, x2: 10, y2: 0 },
        { id: 'w-2', x1: 10, y1: 0, x2: 10, y2: 5 },
        { id: 'w-3', x1: 10, y1: 5, x2: 0, y2: 5 },
        { id: 'w-4', x1: 0, y1: 5, x2: 0, y2: 0 },
      ],
      [{ id: 'sp-1', x: 5, y: 2.5 }],
    );

    computeSpaceBoundaries(levelDir);
    const fc1 = readFileSync(join(levelDir.path, 'space.geojson'), 'utf-8');
    computeSpaceBoundaries(levelDir);
    const fc2 = readFileSync(join(levelDir.path, 'space.geojson'), 'utf-8');
    expect(fc1).toBe(fc2);
  });

  it('returns no artifacts when no space.csv exists', () => {
    const levelPath = join(testDir, 'lv-1');
    mkdirSync(levelPath, { recursive: true });
    const result = computeSpaceBoundaries({ name: 'lv-1', path: levelPath });
    expect(result.geojsonWritten).toBe(false);
    expect(result.warnings).toHaveLength(0);
  });

  it('counts a global wall only on the levels it stands on', () => {
    // A 10 × 4 room on lv-1 and on lv-3; a global wall from lv-1 up to lv-3's floor halves it
    const square = [
      { id: 'w-1', x1: 0, y1: 0, x2: 10, y2: 0 }, { id: 'w-2', x1: 10, y1: 0, x2: 10, y2: 4 },
      { id: 'w-3', x1: 10, y1: 4, x2: 0, y2: 4 }, { id: 'w-4', x1: 0, y1: 4, x2: 0, y2: 0 },
    ];
    const lv1 = setupLevel(square, [{ id: 'sp-1', x: 2, y: 2 }]);
    const lv3Path = join(testDir, 'lv-3');
    mkdirSync(lv3Path, { recursive: true });
    for (const f of ['wall.geojson', 'wall.csv', 'space.csv']) writeFileSync(join(lv3Path, f), readFileSync(join(lv1.path, f)));
    const globalDir = join(testDir, 'global');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, 'level.csv'), 'id,number,name,elevation\nlv-1,1,,0\nlv-2,2,,3\nlv-3,3,,6\n');
    writeFileSync(join(globalDir, 'wall.csv'), 'id,base_level_id,top_level_id,thickness\nw-9,lv-1,lv-3,0.2\n');
    writeFileSync(join(globalDir, 'wall.geojson'), stringifyFeatureCollection({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { id: 'w-9' }, geometry: { type: 'LineString', coordinates: [[5, 0], [5, 4]] } }],
    }));
    computeSpaceBoundaries(lv1, globalDir);
    computeSpaceBoundaries({ name: 'lv-3', path: lv3Path }, globalDir);
    const ring1 = (readSpaceFc(lv1.path).features[0].geometry.coordinates as number[][][])[0];
    expect(Math.max(...ring1.map((p) => p[0]))).toBe(5); // halved by the global wall
    const ring3 = (readSpaceFc(lv3Path).features[0].geometry.coordinates as number[][][])[0];
    expect(Math.max(...ring3.map((p) => p[0]))).toBe(10); // whole room
  });

  it('warns when no boundary elements exist', () => {
    const levelPath = join(testDir, 'lv-1');
    mkdirSync(levelPath, { recursive: true });
    writeFileSync(
      join(levelPath, 'space.csv'),
      'id,number,x,y,name\nsp-1,,5,2.5,Room\n',
    );
    const result = computeSpaceBoundaries({ name: 'lv-1', path: levelPath });
    expect(result.geojsonWritten).toBe(false);
    expect(result.warnings.some((w) => w.includes('no boundary elements'))).toBe(true);
  });

  describe('derived-room overlap and leak warnings', () => {
    const box = (p: string, x0: number, y0: number, x1: number, y1: number) => [
      { id: `${p}-1`, x1: x0, y1: y0, x2: x1, y2: y0 },
      { id: `${p}-2`, x1: x1, y1: y0, x2: x1, y2: y1 },
      { id: `${p}-3`, x1: x1, y1: y1, x2: x0, y2: y1 },
      { id: `${p}-4`, x1: x0, y1: y1, x2: x0, y2: y0 },
    ];

    it('reports no room issues for clean adjacent rooms', () => {
      const levelDir = setupLevel(
        [...box('w', 0, 0, 10, 5), { id: 'w-5', x1: 5, y1: 0, x2: 5, y2: 5 }],
        [{ id: 'sp-1', x: 2.5, y: 2.5 }, { id: 'sp-2', x: 7.5, y: 2.5 }],
      );
      const result = computeSpaceBoundaries(levelDir);
      expect(result.roomIssues).toEqual([]);
    });

    it('warns when two seeds land in the same enclosed area', () => {
      const levelDir = setupLevel(box('w', 0, 0, 10, 5), [
        { id: 'sp-1', x: 2.5, y: 2.5 },
        { id: 'sp-2', x: 7.5, y: 2.5 },
      ]);
      const result = computeSpaceBoundaries(levelDir);
      expect(result.geojsonWritten).toBe(true);
      expect(result.roomIssues).toEqual([{ kind: 'shared', level: 'lv-1', spaceIds: ['sp-1', 'sp-2'] }]);
      const w = result.warnings.find((x) => x.includes('share one enclosed area'));
      expect(w).toContain('lv-1/space.csv');
      expect(w).toContain('sp-1, sp-2');
      expect(w).toContain('50.0 m²');
      expect(w).toContain('sp-2 is a redundant room');
      // Revit semantics: the first room keeps the area, the redundant one gets 0
      const fc = JSON.parse(readFileSync(join(levelDir.path, 'space.geojson'), 'utf-8'));
      const props = Object.fromEntries(fc.features.map((f: { properties: { id: string } }) => [f.properties.id, f.properties]));
      expect(props['sp-1'].net_area).toBeGreaterThan(40);
      expect(props['sp-1'].redundant).toBeUndefined();
      expect(props['sp-2']).toMatchObject({ net_area: 0, redundant: true });
    });

    it('warns when a partition leaks (stops short) and merges two rooms', () => {
      const levelDir = setupLevel(
        [...box('w', 0, 0, 10, 5), { id: 'w-5', x1: 5, y1: 0, x2: 5, y2: 4 }],
        [{ id: 'sp-1', x: 2.5, y: 2.5 }, { id: 'sp-2', x: 7.5, y: 2.5 }],
      );
      const result = computeSpaceBoundaries(levelDir);
      expect(result.roomIssues.map((r) => r.kind)).toEqual(['shared']);
      expect(result.roomIssues[0].spaceIds).toEqual(['sp-1', 'sp-2']);
    });

    it('warns when a room polygon contains another room', () => {
      // A free-standing 2x2 room inside a 10x10 hall: its walls never touch the hall's.
      const levelDir = setupLevel([...box('w', 0, 0, 10, 10), ...box('wi', 4, 4, 6, 6)], [
        { id: 'sp-1', x: 1, y: 1 },
        { id: 'sp-2', x: 5, y: 5 },
      ]);
      const result = computeSpaceBoundaries(levelDir);
      expect(result.roomIssues).toEqual([
        { kind: 'contains', level: 'lv-1', spaceIds: ['sp-1'], inside: ['sp-2'] },
      ]);
      const w = result.warnings.find((x) => x.includes(' contains '));
      expect(w).toContain('lv-1/space.csv  sp-1 polygon (100.0 m²) contains sp-2');
    });

    it('reports only the immediate container for nested rooms', () => {
      const levelDir = setupLevel(
        [...box('w', 0, 0, 20, 20), ...box('wa', 2, 2, 12, 12), ...box('wb', 5, 5, 7, 7)],
        [{ id: 'sp-1', x: 1, y: 1 }, { id: 'sp-2', x: 3, y: 3 }, { id: 'sp-3', x: 6, y: 6 }],
      );
      const result = computeSpaceBoundaries(levelDir);
      expect(result.roomIssues).toEqual([
        { kind: 'contains', level: 'lv-1', spaceIds: ['sp-1'], inside: ['sp-2'] },
        { kind: 'contains', level: 'lv-1', spaceIds: ['sp-2'], inside: ['sp-3'] },
      ]);
    });

    it('reports an unbounded seed with its id and level', () => {
      const levelDir = setupLevel(box('w', 0, 0, 10, 5), [
        { id: 'sp-1', x: 5, y: 2.5 },
        { id: 'sp-2', x: 20, y: 20 },
      ]);
      const result = computeSpaceBoundaries(levelDir);
      expect(result.roomIssues).toEqual([{ kind: 'unbounded', level: 'lv-1', spaceIds: ['sp-2'] }]);
      expect(result.warnings.some((w) => w.startsWith('[warn] lv-1/space.csv  sp-2') && w.includes('no enclosing boundary'))).toBe(true);
    });

    it('labels areas in the project units', () => {
      writeFileSync(join(testDir, 'project_metadata.json'), JSON.stringify({ format_version: '3.0', units: 'ft' }));
      const levelDir = setupLevel(box('w', 0, 0, 10, 5), [
        { id: 'sp-1', x: 2.5, y: 2.5 },
        { id: 'sp-2', x: 7.5, y: 2.5 },
      ]);
      const result = computeSpaceBoundaries(levelDir);
      expect(result.warnings.find((x) => x.includes('share one'))).toContain('50.0 ft²');
    });
  });
});
