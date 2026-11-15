import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as W from 'web-ifc';
import { importIfc } from './index.js';
import { fixtureIfc, type FixtureHelpers } from './fixture.test-util.js';
import { readCsv } from '../utils/csv.js';
import { build } from '../build/index.js';
import { mepReport } from '../mep/index.js';
import { librarySection, outlineSection, parseDesignation, sectionColumns } from './profiles.js';
import { gradeFromText } from './materials.js';
import { classifySystem } from './mep-systems.js';

let api: W.IfcAPI;
beforeAll(async () => {
  api = new W.IfcAPI();
  await api.Init();
  api.SetLogLevel(W.LogLevel.LOG_LEVEL_OFF);
});

const enc = (s: string) => new TextEncoder().encode(s);

function writeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'bd-ifc-mep-'));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
}

/** All rows of a table over every folder (id → row). */
function table(files: Record<string, string>, name: string): Map<string, Record<string, string>> {
  const dir = writeProject(files);
  try {
    const out = new Map<string, Record<string, string>>();
    for (const p of Object.keys(files)) {
      if (!p.endsWith(`/${name}.csv`)) continue;
      for (const r of readCsv(join(dir, p)).rows) out.set(r.id, r);
    }
    return out;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function point(files: Record<string, string>, id: string): number[] {
  for (const [p, c] of Object.entries(files)) {
    if (!p.endsWith('.geojson')) continue;
    const f = JSON.parse(c).features.find((x: { properties: { id: string } }) => x.properties.id === id);
    if (f) return f.geometry.coordinates;
  }
  throw new Error(`no feature ${id}`);
}

// ─── IFC writers on top of the fixture helpers (mm, storey frame) ────────────

let n = 0;
const g = (h: FixtureHelpers) => h.guid(`g${++n}`);

function segment(h: FixtureHelpers, name: string, a: number[], b: number[], w: number, ht: number): string {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const L = Math.hypot(d[0], d[1], d[2]);
  const u = d.map(x => x / L);
  const perp = Math.abs(u[2]) < 0.9 ? [-u[1], u[0], 0] : [1, 0, 0];
  const pl = h.add(`IFCLOCALPLACEMENT(${h.storey},${h.add(`IFCAXIS2PLACEMENT3D(${h.pt(a[0], a[1], a[2])},${h.dir(u[0], u[1], u[2])},${h.dir(perp[0], perp[1], perp[2])})`)})`);
  const prof = h.add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,${h.add(`IFCAXIS2PLACEMENT2D(${h.pt2(0, 0)},$)`)},${h.f(w)},${h.f(ht)})`);
  const solid = h.add(`IFCEXTRUDEDAREASOLID(${prof},${h.add(`IFCAXIS2PLACEMENT3D(${h.pt(0, 0, 0)},$,$)`)},${h.dir(0, 0, 1)},${h.f(L)})`);
  return h.add(`IFCFLOWSEGMENT(${g(h)},$,'${name}',$,$,${pl},${h.shape([solid])},$)`);
}

function host(h: FixtureHelpers, cls: string, name: string, min: number[], max: number[]): string {
  const body = h.box((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, max[0] - min[0], max[1] - min[1], max[2] - min[2], min[2]);
  return h.add(`${cls}(${g(h)},$,'${name}',$,$,${h.placeAt(0, 0)},${h.shape([body])},$)`);
}

function port(h: FixtureHelpers, el: string, flow: 'SINK' | 'SOURCE', at?: number[]): string {
  const pl = at ? h.add(`IFCLOCALPLACEMENT(${h.storey},${h.add(`IFCAXIS2PLACEMENT3D(${h.pt(at[0], at[1], at[2])},$,$)`)})`) : '$';
  const p = h.add(`IFCDISTRIBUTIONPORT(${g(h)},$,'Port',$,$,${pl},$,.${flow}.)`);
  h.add(`IFCRELCONNECTSPORTTOELEMENT(${g(h)},$,$,$,${p},${el})`);
  return p;
}

const link = (h: FixtureHelpers, a: string, b: string) => h.add(`IFCRELCONNECTSPORTS(${g(h)},$,$,$,${a},${b},$)`);

function pset(h: FixtureHelpers, name: string, props: Record<string, string>, els: string[]): void {
  const ps = Object.entries(props).map(([k, v]) => h.add(`IFCPROPERTYSINGLEVALUE('${k}',$,IFCLABEL('${v}'),$)`));
  const set = h.add(`IFCPROPERTYSET(${g(h)},$,'${name}',$,(${ps.join(',')}))`);
  h.add(`IFCRELDEFINESBYPROPERTIES(${g(h)},$,$,$,(${els.join(',')}),${set})`);
}

// A supply run, Revit / Solibri style (ports without placements): duct A into
// an elbow, duct B on to a diffuser, a branch D tapped into B's side ending on
// a round elbow that carries a second diffuser directly (no duct between).
const supply = fixtureIfc({
  walls: [],
  extra: h => {
    const A = segment(h, 'Rectangular Duct:Mitered Elbows:101', [0, 0, 3000], [4000, 0, 3000], 300, 300);
    const E = host(h, 'IFCFLOWFITTING', 'M_Rectangular Elbow - Mitered:Standard:Standard:102', [4000, -150, 2850], [4300, 150, 3150]);
    const B = segment(h, 'Rectangular Duct:Mitered Elbows:103', [4150, 150, 3000], [4150, 4000, 3000], 300, 300);
    const T = host(h, 'IFCFLOWTERMINAL', 'M_Supply Diffuser:600 x 600:104', [4000, 4000, 2850], [4300, 4300, 3150]);
    const D = segment(h, 'Rectangular Duct:Taps:105', [4300, 2000, 3000], [6000, 2000, 3000], 200, 200);
    const E2 = host(h, 'IFCFLOWFITTING', 'M_Round Elbow:1.5 D:1.5 D:106', [6000, 1900, 2900], [6200, 2100, 3100]);
    const T2 = host(h, 'IFCFLOWTERMINAL', 'M_Supply Diffuser:300 x 300:107', [6000, 2100, 2900], [6200, 2400, 3100]);
    port(h, A, 'SINK');
    const a1 = port(h, A, 'SOURCE');
    const e0 = port(h, E, 'SINK'), e1 = port(h, E, 'SOURCE');
    const b0 = port(h, B, 'SINK'), b1 = port(h, B, 'SOURCE'), b2 = port(h, B, 'SOURCE');
    const t0 = port(h, T, 'SINK');
    const d0 = port(h, D, 'SINK'), d1 = port(h, D, 'SOURCE');
    const f0 = port(h, E2, 'SINK'), f1 = port(h, E2, 'SOURCE');
    const t2 = port(h, T2, 'SINK');
    link(h, a1, e0); link(h, e1, b0); link(h, b1, t0); link(h, b2, d0); link(h, d1, f0); link(h, f1, t2);
    // A second supply system elsewhere (a diffuser not connected to anything)
    const T3 = host(h, 'IFCFLOWTERMINAL', 'M_Supply Diffuser:300 x 300:108', [9000, 0, 2900], [9300, 300, 3100]);
    pset(h, 'Mechanical', { 'System Classification': 'Supply Air', 'System Name': 'Mechanical Supply Air 1' }, [A, E, B, T, D, E2, T2]);
    pset(h, 'Mechanical', { 'System Classification': 'Supply Air', 'System Name': 'Mechanical Supply Air 2' }, [T3]);
    return [A, E, B, T, D, E2, T2, T3];
  },
});

describe('import-ifc MEP connectivity', () => {
  it('rebuilds from / to, taps, connector runs and systems from IFC port connections without placements', () => {
    const { files, report } = importIfc(api, enc(supply));
    const ducts = table(files, 'duct');
    const nodes = table(files, 'mep_node');
    const terms = table(files, 'terminal');
    const elbow = [...nodes.values()].find(r => r.family === 'M_Rectangular Elbow - Mitered')!;
    const round = [...nodes.values()].find(r => r.family === 'M_Round Elbow')!;
    const tap = [...nodes.values()].find(r => r.fitting === 'tap' && !r.family)!;
    const diffuser = [...terms.values()].find(r => r.type === '600 x 600')!;
    const [diffuser2, diffuser3] = [...terms.values()].filter(r => r.type === '300 x 300');
    expect(elbow.fitting).toBe('elbow');
    expect(elbow.type).toBe('Standard');
    expect(elbow.number ?? '').toBe('');
    // Elbow on the intersection of its legs' axes, not its body centre / port mean
    expect(point(files, elbow.id).slice(0, 2)).toEqual([4.15, 0]);
    const byNumberless = [...ducts.values()];
    const A = byNumberless.find(r => r.to === elbow.id && !r.from)!;
    expect(A).toBeTruthy();
    // B is split at the tap: elbow → tap → diffuser
    expect(byNumberless.find(r => r.from === elbow.id && r.to === tap.id)).toBeTruthy();
    expect(byNumberless.find(r => r.from === tap.id && r.to === diffuser.id)).toBeTruthy();
    // Branch D from the tap to the round elbow; a connector run carries the second diffuser
    expect(byNumberless.find(r => r.from === tap.id && r.to === round.id)).toBeTruthy();
    expect(byNumberless.find(r => r.from === round.id && r.to === diffuser2.id)).toBeTruthy();
    expect(byNumberless.find(r => r.from === tap.id && r.to === round.id)!.system_type).toBe('SA-1');
    expect(report.mep).toMatchObject({ sourceLinks: 6, linksUsed: 6, taps: 1, connectors: 1, openEnds: 1, sourceOpenEnds: 1, systems: 2 });
    // Systems: one tag per Revit system, numbered within the classification
    const systems = table(files, 'mep_system');
    expect([...systems.values()].map(s => [s.system_type, s.name, s.discipline])).toEqual([
      ['SA-1', 'Mechanical Supply Air 1', 'hvac'], ['SA-2', 'Mechanical Supply Air 2', 'hvac'],
    ]);
    expect(A.system_type).toBe('SA-1');
    expect(diffuser.system_type).toBe('SA-1');
    expect(diffuser2.system_type).toBe('SA-1');
    expect(diffuser3.system_type).toBe('SA-2');
    expect(tap.system_type).toBe('SA-1');
    expect(JSON.parse(files['project_metadata.json']).discipline).toBe('mep');
    // Valid, and the connectivity check sees only the open end the source has too
    const dir = writeProject(files);
    try {
      expect(build(dir).issues).toEqual([]);
      const problems = mepReport(dir).problems.filter(p => p.severity === 'warning');
      expect(problems.map(p => [p.id, p.code])).toEqual([[A.id, 'open_end']]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('connects port-less pipes and fittings by geometry', () => {
    const ifc = fixtureIfc({
      walls: [],
      extra: h => {
        const P1 = segment(h, 'Pipe Types:Standard:201', [0, 0, 1000], [2000, 0, 1000], 50, 50);
        const F = host(h, 'IFCFLOWFITTING', 'Elbow - Generic:Standard:202', [2000, -40, 960], [2080, 40, 1040]);
        const P2 = segment(h, 'Pipe Types:Standard:203', [2040, 40, 1000], [2040, 1500, 1000], 50, 50);
        const S = host(h, 'IFCFLOWTERMINAL', 'Sink:Standard:204', [1900, 1500, 700], [2200, 1900, 1000]);
        pset(h, 'PSet_Revit_Mechanical', { 'System Type': 'Domestic Cold Water', 'System Name': 'Unit A Domestic Cold Water' }, [P1, F, P2]);
        return [P1, F, P2, S];
      },
    });
    const { files, report } = importIfc(api, enc(ifc));
    const pipes = [...table(files, 'pipe').values()];
    const fit = [...table(files, 'mep_node').values()][0];
    const sink = [...table(files, 'terminal').values()][0];
    expect(fit.fitting).toBe('elbow');
    expect(pipes.find(p => p.to === fit.id && !p.from)).toBeTruthy();
    expect(pipes.find(p => p.from === fit.id && p.to === sink.id)).toBeTruthy();
    expect(report.mep).toMatchObject({ sourcePorts: 0, inferred: 3 });
    expect(pipes[0].system_type).toBe('DCW');
    // The sink takes the system of the pipe it sits on
    expect(sink.system_type).toBe('DCW');
  });

  it('declares equipment ports where their ducts end (host:port refs)', () => {
    const ifc = fixtureIfc({
      walls: [],
      extra: h => {
        const ahu = host(h, 'IFCENERGYCONVERSIONDEVICE', 'AHU:Type A:301', [0, 0, 0], [2000, 1000, 1500]);
        const S = segment(h, 'Rectangular Duct:Standard:302', [2000, 500, 1200], [4000, 500, 1200], 400, 300);
        const p = port(h, ahu, 'SOURCE'), q = port(h, S, 'SINK');
        port(h, S, 'SOURCE');
        link(h, p, q);
        pset(h, 'Mechanical', { 'System Classification': 'Supply Air' }, [S]);
        return [ahu, S];
      },
    });
    const { files } = importIfc(api, enc(ifc));
    const eq = [...table(files, 'equipment').values()][0];
    const conns = [...table(files, 'connector').values()];
    const duct = [...table(files, 'duct').values()][0];
    expect(conns).toHaveLength(1);
    expect(conns[0]).toMatchObject({ host_id: eq.id, name: 'sa', system_type: 'SA', domain: 'hvac', flow_dir: 'out', shape: 'rect' });
    expect([conns[0].offset_x, conns[0].offset_y, conns[0].offset_z].map(Number)).toEqual([1, 0, 1.2]);
    expect(duct.from).toBe(`${eq.id}:sa`);
    expect(eq.family).toBe('AHU');
    const dir = writeProject(files);
    try {
      expect(build(dir).issues).toEqual([]);
      expect(mepReport(dir).problems.filter(p => p.severity === 'warning').map(p => p.code)).toEqual(['open_end']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ─── Structure ───────────────────────────────────────────────────────────────

/** W310X39 outline (mm), centred: bf 165, d 310, tf 9.7, tw 5.8. */
const W310 = (() => {
  const b = 82.5, d = 155, tf = 9.7, tw = 2.9;
  return [[-b, -d], [b, -d], [b, -d + tf], [tw, -d + tf], [tw, d - tf], [b, d - tf], [b, d], [-b, d], [-b, d - tf], [-tw, d - tf], [-tw, -d + tf], [-b, -d + tf]];
})();

describe('import-ifc structural sections, types and grades', () => {
  it('reads an arbitrary I outline, family types into beam_type / column_type rows and the steel / concrete grade', () => {
    const ifc = fixtureIfc({
      walls: [],
      extra: h => {
        const steel = h.add(`IFCMATERIAL('Metal - Steel - 345 MPa')`);
        const concrete = h.add(`IFCMATERIAL('Concrete C30/37')`);
        const beams = [0, 4000].map((y, i) => {
          const pl = h.add(`IFCLOCALPLACEMENT(${h.storey},${h.add(`IFCAXIS2PLACEMENT3D(${h.pt(0, y, 3000)},${h.dir(1, 0, 0)},${h.dir(0, 1, 0)})`)})`);
          const poly = h.add(`IFCPOLYLINE((${[...W310, W310[0]].map(([x, z]) => h.pt2(x, z)).join(',')}))`);
          const prof = h.add(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,${poly})`);
          const solid = h.add(`IFCEXTRUDEDAREASOLID(${prof},${h.add(`IFCAXIS2PLACEMENT3D(${h.pt(0, 0, 0)},$,$)`)},${h.dir(0, 0, 1)},${h.f(6000)})`);
          return h.add(`IFCBEAM(${g(h)},$,'M_W-Wide Flange:W310X39:W310X39:${500 + i}',$,'M_W-Wide Flange:W310X39:499',${pl},${h.shape([solid])},$)`);
        });
        h.add(`IFCRELASSOCIATESMATERIAL(${g(h)},$,$,$,(${beams.join(',')}),${steel})`);
        const hssType = h.add(`IFCCOLUMNTYPE(${g(h)},$,'HSS152X152X9.5',$,$,$,$,$,$,.COLUMN.)`);
        const cType = h.add(`IFCCOLUMNTYPE(${g(h)},$,'400 x 400mm',$,$,$,$,$,$,.COLUMN.)`);
        const col = (x: number, size: number, name: string) => h.add(`IFCCOLUMN(${g(h)},$,'${name}',$,$,${h.placeAt(x, 0)},${h.shape([h.box(0, 0, size, size, 3000)])},$)`);
        const hss = col(0, 152, 'HSS-Column:HSS152X152X9.5:601');
        const con = col(6000, 400, 'M_Concrete-Rectangular-Column:400 x 400mm:602');
        h.add(`IFCRELDEFINESBYTYPE(${g(h)},$,$,$,(${hss}),${hssType})`);
        h.add(`IFCRELDEFINESBYTYPE(${g(h)},$,$,$,(${con}),${cType})`);
        h.add(`IFCRELASSOCIATESMATERIAL(${g(h)},$,$,$,(${hss}),${steel})`);
        h.add(`IFCRELASSOCIATESMATERIAL(${g(h)},$,$,$,(${con}),${concrete})`);
        return [...beams, hss, con];
      },
    });
    const { files } = importIfc(api, enc(ifc));
    const beamTypes = [...table(files, 'beam_type').values()];
    expect(beamTypes).toHaveLength(1);
    expect(beamTypes[0]).toMatchObject({ name: 'W310X39', description: 'M_W-Wide Flange', shape: 'i_shape', size_x: '0.165', size_y: '0.31', flange: '0.01', web: '0.006', material: 'steel' });
    const beams = [...table(files, 'beam').values()];
    expect(beams).toHaveLength(2);
    for (const b of beams) {
      expect(b.type_id).toBe(beamTypes[0].id);
      expect(b.number ?? '').toBe('');
      expect(b.shape ?? '').toBe('');
      expect(b.material_grade).toBe('345 MPa');
    }
    const colTypes = new Map([...table(files, 'column_type').values()].map(t => [t.name, t]));
    expect(colTypes.get('HSS152X152X9.5')).toMatchObject({ shape: 'rect_hollow', size_x: '0.152', size_y: '0.152', thickness: '0.01', material: 'steel' });
    expect(colTypes.get('400 x 400mm')).toMatchObject({ shape: 'rect', size_x: '0.4', material: 'concrete' });
    const cols = [...table(files, 'structure_column').values()];
    expect(cols.map(c => c.material_grade).sort()).toEqual(['345 MPa', 'C30/37']);
    const dir = writeProject(files);
    try { expect(build(dir).issues).toEqual([]); } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('maps catalogue designations to the steel library (dimensions, root radius, library spelling)', () => {
    expect(librarySection('HEA200')).toMatchObject({ kind: 'i', width: 0.2, depth: 0.19, flange: 0.01, web: 0.0065, rootRadius: 0.018, designation: 'HEA 200' });
    expect(librarySection('chs219.1X8')).toMatchObject({ kind: 'chs', width: 0.2191, thickness: 0.008, designation: 'CHS 219.1x8' });
    expect(librarySection('HEA200', 'chs')).toBeNull();
    expect(librarySection('XYZ123')).toBeNull();
    expect(sectionColumns(librarySection('HEA 200')!)).toMatchObject({ shape: 'i_shape', root_radius: 0.018, designation: 'HEA 200' });
  });

  it('parses steel designations', () => {
    expect(parseDesignation('M_W-Wide Flange:W460X60')).toMatchObject({ designation: 'W460X60', kind: 'i' });
    expect(parseDesignation('HEA200')).toMatchObject({ designation: 'HEA200', kind: 'i' });
    expect(parseDesignation('IPE 300')).toMatchObject({ designation: 'IPE300', kind: 'i' });
    expect(parseDesignation('UPN200')).toMatchObject({ kind: 'c' });
    expect(parseDesignation('C250X30')).toMatchObject({ kind: 'c' });
    expect(parseDesignation('WT205X30')).toMatchObject({ kind: 't' });
    const hss = parseDesignation('HSS152X152X9.5')!;
    expect(hss.kind).toBe('rhs');
    expect(hss.dims).toMatchObject({ width: 0.152, depth: 0.152, thickness: 0.0095 });
    expect(parseDesignation('HSS6X6X1/4')!.dims.thickness).toBeCloseTo(0.00635);
    expect(parseDesignation('CHS114.3X6.3')).toMatchObject({ kind: 'chs', dims: { width: 0.1143, thickness: 0.0063 } });
    expect(parseDesignation('L100X100X10')).toMatchObject({ kind: 'l', dims: { width: 0.1, thickness: 0.01 } });
    expect(parseDesignation('H400X200X8X13')).toMatchObject({ kind: 'i', dims: { depth: 0.4, width: 0.2, web: 0.008, flange: 0.013 } });
    expect(parseDesignation('400 x 400mm')).toBeNull();
    expect(parseDesignation('14K1')).toBeNull();
  });

  it('reads outlines as sections', () => {
    const m = (pts: number[][]) => pts.map(([x, y]) => ({ x: x / 1000, y: y / 1000 }));
    const i = outlineSection(m(W310), [])!;
    expect(i.kind).toBe('i');
    expect(i.width).toBeCloseTo(0.165);
    expect(i.depth).toBeCloseTo(0.31);
    expect(i.flange!).toBeCloseTo(0.0097, 3);
    expect(i.web!).toBeCloseTo(0.0058, 3);
    // Channel: web on the left
    expect(outlineSection(m([[0, 0], [100, 0], [100, 10], [8, 10], [8, 190], [100, 190], [100, 200], [0, 200]]), [])?.kind).toBe('c');
    expect(outlineSection(m([[0, 0], [100, 0], [100, 10], [10, 10], [10, 100], [0, 100]]), [])).toMatchObject({ kind: 'l', thickness: 0.01 });
    expect(outlineSection(m([[-50, 90], [50, 90], [50, 100], [-50, 100]]), [])?.kind).toBe('rect');
    expect(outlineSection(m([[-100, 0], [100, 0], [100, 300], [-100, 300]]), [m([[-90, 10], [90, 10], [90, 290], [-90, 290]])])?.thickness).toBeCloseTo(0.01);
  });

  it('parses strength grades', () => {
    expect(gradeFromText('Metal - Steel - 345 MPa', 'steel')).toBe('345 MPa');
    expect(gradeFromText('Beton C30/37', 'concrete')).toBe('C30/37');
    expect(gradeFromText('Stahl S355JR', 'steel')).toBe('S355JR');
    expect(gradeFromText('Q355B', 'steel')).toBe('Q355B');
    expect(gradeFromText('ASTM A992', 'steel')).toBe('A992');
    expect(gradeFromText('A572 Grade 50', 'steel')).toBe('A572 Gr. 50');
    expect(gradeFromText('C30 混凝土', 'concrete')).toBe('C30');
    expect(gradeFromText('Glulam GL24h', 'wood')).toBe('GL24h');
    expect(gradeFromText('Concrete 4000 psi', 'concrete')).toBe('4000 psi');
    expect(gradeFromText('Concrete - Cast-in-Place Concrete', 'concrete')).toBeNull();
  });

  it('classifies system names', () => {
    expect(classifySystem('Hydronic Return')?.tag).toBe('HWR');
    expect(classifySystem('Supply Air')?.tag).toBe('SA');
    expect(classifySystem('Return Air')?.tag).toBe('RA');
    expect(classifySystem('Zuluft')?.tag).toBe('SA');
    expect(classifySystem('Fortluft')?.tag).toBe('EA');
    expect(classifySystem('Domestic Cold Water')?.tag).toBe('DCW');
    expect(classifySystem('Domestic Hot Water')?.tag).toBe('DHW');
    expect(classifySystem('Sanitary')?.tag).toBe('SAN');
    expect(classifySystem('Wet Fire Protection')?.tag).toBe('FP');
  });
});
