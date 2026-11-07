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
    + 'cn-1,eq-1,sa,-1,0,1,-1,0,0,rect,0.5,0.3,SA,out,hvac\n'
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
});
