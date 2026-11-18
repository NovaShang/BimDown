import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mepReport, mepWarnings } from './index.js';
import { checkMep } from './check.js';
import { resolveTopology } from '../commands/resolve-topology.js';
import { build } from '../build/index.js';
import { renderLevel } from '../render.js';

const dir = join(__dirname, 'test-mep');
const fc = (features: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features });
const line = (id: string, a: number[], b: number[]) => ({ type: 'Feature', properties: { id }, geometry: { type: 'LineString', coordinates: [a, b] } });
const point = (id: string, p: number[], props: Record<string, unknown> = {}) => ({ type: 'Feature', properties: { id, ...props }, geometry: { type: 'Point', coordinates: p } });
const put = (rel: string, text: string) => writeFileSync(join(dir, rel), text);

/** AHU (sa port at local (-1, 0, 1)) → duct main → two diffusers (inlet at the top, z 2.75). */
function office(opts: { branchOnBody?: boolean; offPort?: boolean } = {}) {
  put('lv-1/equipment.csv', 'id,number,system_type,equipment_type,flow\neq-1,AHU-1,SA,ahu,200\n');
  put('lv-1/equipment.geojson', fc([point('eq-1', [0, 0, 0], { size: [2, 1, 1.4] })]));
  put('lv-1/terminal.csv', 'id,number,system_type,terminal_type,flow\ntm-1,,SA,supply_air_diffuser,100\ntm-2,,SA,supply_air_diffuser,100\n');
  put('lv-1/terminal.geojson', fc([point('tm-1', [-5, 4, 2.7]), point('tm-2', [-9, 4, 2.7])]));
  put('lv-1/connector.csv', 'id,host_id,name,offset_x,offset_y,offset_z,dir_x,dir_y,dir_z,shape,size_w,size_h,system_type,flow_dir,domain\n'
    + 'cn-1,eq-1,sa,-1,0,1,-1,0,0,rect,0.4,0.3,SA,out,hvac\n'
    + 'cn-2,tm-1,inlet,0,0,0.05,0,0,1,rect,0.3,0.3,SA,in,hvac\n'
    + 'cn-3,tm-2,inlet,0,0,0.05,0,0,1,rect,0.3,0.3,SA,in,hvac\n');
  const start = opts.offPort ? [-1.3, 0, 1] : [-1, 0, 1];
  const ducts: [string, number[], number[]][] = [
    ['du-1', start, [-2, 0, 1]],
    ['du-2', [-2, 0, 1], [-2, 0, 3]],
    ['du-3', [-2, 0, 3], [-9, 0, 3]],
    ['du-4', [-9, 0, 3], [-9, 4, 3]],
    ['du-5', [-9, 4, 3], [-9, 4, 2.75]],
    // branch to tm-1: starts on the main's body
    ['du-6', [-5, opts.branchOnBody ? 0 : 0.5, 3], [-5, 4, 3]],
    ['du-7', [-5, 4, 3], [-5, 4, 2.75]],
  ];
  put('lv-1/duct.csv', 'id,shape,size_x,size_y,system_type,from,to\n' + ducts.map(([id]) => `${id},rect,0.4,0.3,SA,,`).join('\n') + '\n');
  put('lv-1/duct.geojson', fc(ducts.map(([id, a, b]) => line(id, a, b))));
}

describe('MEP connectivity', () => {
  beforeEach(() => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'global'), { recursive: true });
    mkdirSync(join(dir, 'lv-1'), { recursive: true });
    put('project_metadata.json', JSON.stringify({ format_version: 2, units: 'm' }));
    put('global/level.csv', 'id,number,name,elevation\nlv-1,1,1F,0\n');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('resolve-topology connects ports, joints and a branch on a main body (splitting the main)', () => {
    office({ branchOnBody: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    resolveTopology(dir);
    vi.restoreAllMocks();
    const csv = readFileSync(join(dir, 'lv-1/duct.csv'), 'utf-8');
    expect(csv).toContain('du-1,rect,0.4,0.3,SA,eq-1:sa,');
    expect(csv).toContain('du-5,rect,0.4,0.3,SA,mn-');
    expect(csv).toMatch(/du-7,.*,tm-1:inlet/);
    expect(csv).toContain('du-8,'); // the main split at the tee
    const r = mepReport(dir);
    expect(r.problems.filter(p => p.severity === 'warning')).toEqual([]);
    expect(build(dir).warnings.filter(w => w.includes('duct.csv'))).toEqual([]);
    expect(r.systems.find(s => s.system === 'SA')?.devices).toBe(3);
  });

  it('reports open ends, ends off their port and disconnected devices', () => {
    office({ offPort: true });
    put('lv-1/duct.csv', readFileSync(join(dir, 'lv-1/duct.csv'), 'utf-8').replace('du-1,rect,0.4,0.3,SA,,', 'du-1,rect,0.4,0.3,SA,eq-1:sa,'));
    const codes = mepWarnings(dir).map(w => w.match(/\[(\w+)\]/)?.[1]);
    expect(codes).toContain('port_far');
    expect(codes).toContain('open_end');
    expect(codes).toContain('disconnected_device');
  });

  it('a reference to a missing port or element is a build error, not a warning', () => {
    office();
    put('lv-1/duct.csv', readFileSync(join(dir, 'lv-1/duct.csv'), 'utf-8')
      .replace('du-5,rect,0.4,0.3,SA,,', 'du-5,rect,0.4,0.3,SA,,tm-2:foo')
      .replace('du-7,rect,0.4,0.3,SA,,', 'du-7,rect,0.4,0.3,SA,,tm-9:inlet'));
    const r = build(dir);
    expect(r.issues.filter(i => i.includes('[dangling_ref]')).length).toBe(2);
    expect(r.warnings.some(w => w.includes('[dangling_ref]'))).toBe(false);
  });

  it('ids are per level: a ref resolves in its own level first', () => {
    const m = checkMep({
      curves: [{ id: 'pi-1', scope: 'lv-2', table: 'pipe', a: [0, 0, 7], b: [1, 0, 7], from: 'mn-1', to: '', system: 'DCW' }],
      hosts: [
        { id: 'mn-1', scope: 'lv-1', table: 'mep_node', pos: [50, 0, 3], kind: '', fitting: '', system: '', circuitId: '', load: 0 },
        { id: 'mn-1', scope: 'lv-2', table: 'mep_node', pos: [0, 0, 7], kind: '', fitting: 'cap', system: '', circuitId: '', load: 0 },
      ],
      ports: [],
    });
    // lv-2's mn-1 (a cap right at the end) is used, not lv-1's mn-1 50 m away.
    expect(m.map(p => `${p.code}:${p.scope}`)).toEqual(['open_end:lv-2', 'orphan_fitting:lv-1']);
  });

  it('one level at a time: a riser continuing on another level is connected, a ref found nowhere is broken', () => {
    const base = {
      curves: [
        { id: 'pi-9', table: 'pipe', a: [0, 0, 0.5] as [number, number, number], b: [0, 0, 5.1] as [number, number, number], from: 'mn-21', to: 'mn-22', system: 'CWR' },
        { id: 'pi-5', table: 'pipe', a: [-2, 0, 0.5] as [number, number, number], b: [0, 0, 0.5] as [number, number, number], from: 'mn-19', to: 'mn-21', system: 'CWR' },
      ],
      hosts: [
        { id: 'mn-21', table: 'mep_node' as const, pos: [0, 0, 0.5] as [number, number, number], kind: '', fitting: '', system: '', circuitId: '', load: 0 },
        { id: 'mn-22', table: 'mep_node' as const, pos: [0, 0, 5.1] as [number, number, number], kind: '', fitting: '', system: '', circuitId: '', load: 0 },
      ],
      ports: [],
      complete: false,
    };
    const codes = (m: Parameters<typeof checkMep>[0]) => checkMep(m).filter(p => p.severity === 'warning').map(p => `${p.code}:${p.id}`);
    expect(codes(base)).toContain('open_end:pi-9');
    expect(codes({ ...base, externalRefs: ['mn-22'], externalHosts: ['eq-5'] })).toEqual(['dangling_ref:pi-5']);
  });

  it('flags circuits over 80 % of the breaker and devices on a missing circuit', () => {
    const m = checkMep({
      curves: [],
      hosts: [
        { id: 'eq-1', table: 'equipment', pos: [0, 0, 0], kind: '', fitting: '', system: '', circuitId: '', load: 0 },
        { id: 'tm-1', table: 'terminal', pos: [1, 0, 2.7], kind: '', fitting: '', system: '', circuitId: 'ci-1', load: 3000 },
        { id: 'tm-2', table: 'terminal', pos: [2, 0, 2.7], kind: '', fitting: '', system: '', circuitId: 'ci-9', load: 10 },
      ],
      ports: [],
      circuits: [{ id: 'ci-1', hostId: 'eq-1', number: '1', voltage: 230, rating: 16 }],
    });
    expect(m.map(p => p.code).sort()).toEqual(['circuit_overload', 'dangling_ref']);
  });

  it('flags duplicate / overlapping segments (a back-and-forth riser), in build too', () => {
    const v = (x: number, y: number, z: number) => [x, y, z] as [number, number, number];
    const m = checkMep({
      curves: [
        { id: 'pi-18', table: 'pipe', a: v(21.3, 10, 3.628), b: v(21.3, 10, 0), from: 'mn-30', to: 'mn-31', system: 'SAN' },
        { id: 'pi-19', table: 'pipe', a: v(21.3, 10, 0), b: v(21.3, 10, 3.628), from: 'mn-31', to: 'mn-30', system: 'SAN' },
        { id: 'pi-20', table: 'pipe', a: v(0, 0, 0), b: v(5, 0, 0), from: '', to: '', system: 'DCW' },
        { id: 'pi-21', table: 'pipe', a: v(4, 0, 0), b: v(9, 0, 0), from: '', to: '', system: 'DCW' },
        { id: 'pi-22', table: 'pipe', a: v(5, 0, 0), b: v(9, 0, 0.2), from: '', to: '', system: 'DCW' },
        { id: 'du-1', table: 'duct', a: v(0, 0, 0), b: v(5, 0, 0), from: '', to: '', system: 'SA' },
      ],
      hosts: [], ports: [],
    }).filter(p => p.code === 'duplicate_segment');
    expect(m.map(p => `${p.id}~${p.other}`).sort()).toEqual(['pi-19~pi-18', 'pi-21~pi-20']);
    office({ branchOnBody: true });
    put('lv-1/duct.csv', readFileSync(join(dir, 'lv-1/duct.csv'), 'utf-8') + 'du-9,rect,0.4,0.3,SA,,\n');
    const geo = JSON.parse(readFileSync(join(dir, 'lv-1/duct.geojson'), 'utf-8'));
    geo.features.push(line('du-9', [-3, 0, 3], [-8, 0, 3]));
    put('lv-1/duct.geojson', JSON.stringify(geo));
    expect(build(dir).warnings.some(w => w.includes('du-9: [duplicate_segment]'))).toBe(true);
  });

  it('flags port size mismatches (equipment: warning, terminal neck: info) and supply flow balance', () => {
    office({ branchOnBody: true });
    put('lv-1/connector.csv', readFileSync(join(dir, 'lv-1/connector.csv'), 'utf-8').replace('rect,0.4,0.3,SA,out', 'rect,0.8,0.5,SA,out'));
    put('lv-1/equipment.csv', 'id,number,system_type,equipment_type,flow\neq-1,AHU-1,SA,ahu,1500\n');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    resolveTopology(dir);
    vi.restoreAllMocks();
    const r = mepReport(dir);
    const sev = (code: string) => r.problems.filter(p => p.code === code).map(p => `${p.severity}:${p.id}`).sort();
    expect(sev('size_mismatch')).toEqual(['info:du-5', 'info:du-7', 'warning:du-1']);
    expect(sev('flow_balance')).toEqual(['warning:eq-1']);
    expect(r.problems.find(p => p.code === 'flow_balance')!.message).toContain('take 200 L/s');
  });

  it('render draws ducts at their size in system colours, fittings, terminal symbols and tags', () => {
    office({ branchOnBody: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    resolveTopology(dir);
    vi.restoreAllMocks();
    put('global/mep_system.csv', 'id,system_type,name,color,discipline\nsys-1,SA,Supply,#123456,hvac\n');
    const svg = renderLevel(dir, 'lv-1');
    expect(svg).toContain('stroke="#123456"');
    expect(svg).toMatch(/data-mep="tee"|data-mep="tap"/);
    expect(svg).toContain('data-mep="riser-down"');
    expect(svg).toContain('SA 400×300');
    expect(svg).toContain('data-mep="supply_air_diffuser"');
  });

  it('oval ducts and flexible ducts / pipes validate, build and render (size tag, hose zigzag, oval riser)', () => {
    put('lv-1/duct.csv', 'id,shape,size_x,size_y,system_type,from,to,flexible\ndu-1,oval,0.5,0.25,SA,,,\ndu-2,round,0.2,,SA,,,true\ndu-3,oval,0.5,0.25,SA,,,\n');
    put('lv-1/duct.geojson', fc([line('du-1', [0, 0, 3], [6, 0, 3]), line('du-2', [6, 0, 3], [8, 2, 3]), line('du-3', [0, 4, 1], [0, 4, 3])]));
    put('lv-1/pipe.csv', 'id,shape,size_x,system_type,from,to,flexible\npi-1,round,0.02,DCW,,,true\n');
    put('lv-1/pipe.geojson', fc([line('pi-1', [2, 2, 0.5], [3, 2, 0.5])]));
    expect(build(dir).issues).toEqual([]);
    const svg = renderLevel(dir, 'lv-1');
    expect(svg).toContain('SA 500×250 oval');
    expect(svg).toMatch(/<g id="du-3"[^>]*>.*rx="0\.125"/);
    // Flex runs get the hose zigzag
    expect(svg.match(/<polyline points=/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('circuit phases and power factor set the current for the overload check; trays over their fill limit warn', () => {
    put('lv-1/equipment.csv', 'id,number,equipment_type,load,circuit_id\neq-1,LP-1,panelboard,,\neq-2,M-1,fan,9000,ci-2\n');
    put('lv-1/equipment.geojson', fc([point('eq-1', [0, 0, 0]), point('eq-2', [5, 0, 0])]));
    // 9 kW three-phase at 400 V, cosφ 0.85: 15.3 A > 0.8 × 16; the same load on one phase at 230 V: 46 A
    put('lv-1/circuit.csv', 'id,number,host_id,name,voltage,poles,rating,phase,power_factor,cable_size,cable_trays\n'
      + 'ci-1,1,eq-1,Spare,230,1,16,L1,,0.03,ct-1\nci-2,2,eq-1,Fan,400,3,16,L1L2L3,0.85,0.03,ct-1\n');
    put('lv-1/cable_tray.csv', 'id,shape,size_x,size_y,system_type,from,to,max_fill\nct-1,rect,0.1,0.05,PWR,,,25\n');
    put('lv-1/cable_tray.geojson', fc([line('ct-1', [0, 1, 3], [6, 1, 3])]));
    expect(build(dir).issues).toEqual([]);
    const w = mepReport(dir).problems.filter(p => p.severity === 'warning');
    const over = w.find(p => p.code === 'circuit_overload')!;
    expect(over.vars).toMatchObject({ id: '2', current: 15.3 });
    // 2 × π·0.015² / 0.005 = 28.3 % > 25 %
    expect(w.find(p => p.code === 'tray_fill')?.vars).toMatchObject({ id: 'ct-1', fill: 28.3, limit: 25, cables: 2 });
  });

  it('render draws a 45° drainage branch as a wye', () => {
    put('lv-1/mep_node.csv', 'id,system_type\nmn-1,SAN\n');
    put('lv-1/mep_node.geojson', fc([point('mn-1', [5, 0, 0.5])]));
    put('lv-1/pipe.csv', 'id,shape,size_x,system_type,from,to\npi-1,round,0.1,SAN,,mn-1\npi-2,round,0.1,SAN,mn-1,\npi-3,round,0.075,SAN,,mn-1\n');
    put('lv-1/pipe.geojson', fc([line('pi-1', [0, 0, 0.5], [5, 0, 0.5]), line('pi-2', [5, 0, 0.5], [10, 0, 0.5]), line('pi-3', [3, 2, 0.5], [5, 0, 0.5])]));
    const svg = renderLevel(dir, 'lv-1');
    expect(svg).toContain('data-mep="wye"');
    expect(svg).not.toContain('data-mep="tee"');
  });
});
