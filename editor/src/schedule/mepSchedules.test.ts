import { describe, it, expect } from 'vitest';
import '../elements/registerAll.ts';
import { load, files } from '../test/annotationFixture.ts';
import { fc } from '../test/memoryDataSource.ts';
import { SCHEDULES, scheduleRows, scheduleGroups, scheduleCsv, formatCell, columnDigits } from './schedules.ts';

const cat = (key: string) => SCHEDULES.find(c => c.key === key)!;
const name = (t: string) => t;
const pt = (id: string, x: number, y: number, z: number, size?: number[]) =>
  ({ type: 'Feature', properties: size ? { id, size } : { id }, geometry: { type: 'Point', coordinates: [x, y, z] } });
const ln = (id: string, a: number[], b: number[]) => ({ type: 'Feature', properties: { id }, geometry: { type: 'LineString', coordinates: [a, b] } });

/** A small plant: AHU + pump + panel, diffusers, CHW pipes with valves, ducts, a circuit. */
function plant() {
  const f = files();
  f['lv-1/equipment.csv'] = 'id,number,system_type,equipment_type,family,type,flow,load\n'
    + 'eq-1,AHU-1,"SA,RA",ahu,AHU - Generic,Standard,1500,\n'
    + 'eq-2,,CHWS,pump,Pump - Inline,Standard,10,2200\n'
    + 'eq-3,,,panelboard,Panelboard,230/400V,,\n';
  f['lv-1/equipment.geojson'] = fc([pt('eq-1', 1, 1, 0, [2.4, 1.2, 1.5]), pt('eq-2', 3, 1, 0, [0.6, 0.35, 0.6]), pt('eq-3', 5, 1, 0, [0.6, 0.2, 1])]);
  f['lv-1/terminal.csv'] = 'id,number,system_type,terminal_type,family,type,flow,load,circuit_id\n'
    + 'tm-1,,SA,supply_air_diffuser,Diffuser - Square,600x600,100,,\n'
    + 'tm-2,,SA,supply_air_diffuser,Diffuser - Square,600x600,120,,\n'
    + 'tm-3,,,light_fixture,Downlight,LED,,36,ci-1\n';
  f['lv-1/terminal.geojson'] = fc([pt('tm-1', 2, 3, 2.7, [0.6, 0.6, 0.05]), pt('tm-2', 4, 3, 2.7, [0.6, 0.6, 0.05]), pt('tm-3', 6, 3, 2.8)]);
  f['lv-1/circuit.csv'] = 'id,number,host_id,name,voltage,poles,rating\nci-1,1,eq-3,Lighting,230,1,16\n';
  f['lv-1/pipe.csv'] = 'id,number,shape,size_x,system_type,material\npi-1,,round,0.065,CHWS,steel\npi-2,,round,0.065,CHWS,steel\npi-3,,round,0.11,SAN,pvc\n';
  f['lv-1/pipe.geojson'] = fc([ln('pi-1', [1, 4, 3], [4.123456, 4, 3]), ln('pi-2', [4.123456, 4, 3], [6, 4, 3]), ln('pi-3', [1, 6, 0.5], [3, 6, 0.5])]);
  f['lv-1/duct.csv'] = 'id,number,shape,size_x,size_y,system_type\ndu-1,,rect,0.4,0.3,SA\n';
  f['lv-1/duct.geojson'] = fc([ln('du-1', [0, 2, 3], [5, 2, 3])]);
  f['lv-1/mep_node.csv'] = 'id,system_type,kind,shape,size_w,size_h\nmn-1,CHWS,gate_valve,round,0.065,\nmn-2,CHWS,strainer,,,\nmn-3,SA,damper,rect,0.4,0.3\nmn-4,CHWS,,,,\n';
  f['lv-1/mep_node.geojson'] = fc([pt('mn-1', 2, 4, 3), pt('mn-2', 6, 4, 3), pt('mn-3', 5, 2, 3), pt('mn-4', 4.123456, 4, 3)]);
  return f;
}

describe('MEP schedules', () => {
  it('equipment: tag, translated type, family / type, system, flow, load (kW), W×D×H in mm', async () => {
    const { state } = await load(plant());
    const rows = scheduleRows(cat('equipment'), state.project!, 'm', name, 'lv-1', state.document!.elements, 'en');
    const ahu = rows.find(r => r.id === 'eq-1')!.values;
    expect(ahu).toMatchObject({ number: 'AHU-1', device_type: 'AHU', family: 'AHU - Generic', family_type: 'Standard', system_type: 'SA,RA', flow: 1500, dims: '2400×1200×1500' });
    expect(rows.find(r => r.id === 'eq-2')!.values.load_kw).toBe(2.2);
    expect(rows.every(r => r.table === 'equipment')).toBe(true);
    const zh = scheduleRows(cat('equipment'), state.project!, 'm', name, 'lv-1', state.document!.elements, 'zh');
    expect(zh.find(r => r.id === 'eq-1')!.values.device_type).toBe('空调机组');
  });

  it('terminals: translated type, flow with totals, size and mounting height', async () => {
    const { state } = await load(plant());
    const c = cat('terminals');
    const rows = scheduleRows(c, state.project!, 'm', name, 'lv-1', state.document!.elements, 'en');
    expect(rows.find(r => r.id === 'tm-1')!.values).toMatchObject({ device_type: 'Supply Air Diffuser', dims: '600×600×50', family_type: '600x600' });
    expect(rows.find(r => r.id === 'tm-1')!.values.mounting).toBeCloseTo(2.7, 6);
    const groups = scheduleGroups(rows, c.columns, c.groupBy!, null);
    expect(groups.map(g => [g.key, g.totals.flow, g.totals.load_w])).toEqual([['Light Fixture', 0, 36], ['Supply Air Diffuser', 220, 0]]);
  });

  it('accessories: kind label, size from size_w / size_h or the run it sits on', async () => {
    const { state } = await load(plant());
    const rows = scheduleRows(cat('accessories'), state.project!, 'm', name, 'lv-1', state.document!.elements, 'en');
    const v = Object.fromEntries(rows.map(r => [r.id, [r.values.kind, r.values.size]]));
    expect(v).toEqual({ 'mn-1': ['Gate Valve', 'DN65'], 'mn-2': ['Strainer', 'DN65'], 'mn-3': ['Volume Damper', '400×300'] });
  });

  it('runs: sizes like the plan tags, one row per system + size with total length, rounded lengths', async () => {
    const { state } = await load(plant());
    const c = cat('mep');
    const rows = scheduleRows(c, state.project!, 'm', name, 'lv-1', state.document!.elements, 'en');
    expect(rows.find(r => r.id === 'pi-1')!.values).toMatchObject({ size: 'DN65', system_size: 'CHWS DN65' });
    expect(rows.find(r => r.id === 'pi-3')!.values.size).toBe('de110');
    expect(rows.find(r => r.id === 'du-1')!.values.system_size).toBe('SA 400×300');
    expect(c.groupBy).toBe('system_size');
    const [g] = scheduleGroups(rows, c.columns, c.groupBy!, null, c.itemize);
    expect(g.rows.map(r => [r.values.system_type, r.values.size, r.values.length, r.values.count])).toEqual([
      ['CHWS', 'DN65', 5, 2], ['SA', '400×300', 5, 1], ['SAN', 'de110', 2, 1],
    ]);
    // Itemized: a segment's length shows / exports to the centimetre
    const len = c.columns.find(x => x.key === 'length')!;
    const pi1 = rows.find(r => r.id === 'pi-1')!.values.length as number;
    expect(formatCell(pi1, 'length', 'm', columnDigits(len, 'm'))).toBe('3.12');
    expect(formatCell(pi1 * 1000, 'length', 'mm', columnDigits(len, 'mm'))).toBe('3123');
    const csv = scheduleCsv(scheduleGroups(rows, c.columns, c.groupBy!, null, true), c.columns, c.columns.map(x => x.key), 'Total', 'm');
    expect(csv).toContain(',3.12,');
    expect(csv).not.toContain('3.123456');
    const aggCsv = scheduleCsv([g], c.columns, c.columns.map(x => x.key), 'Total', 'm').trim().split('\n');
    expect(aggCsv[1].split(',')).toEqual(['pipe', 'CHWS', 'DN65', 'CHWS DN65', '', 'L1', '', '5', '2']);
    expect(aggCsv.pop()).toBe('Total,,,,,,,12,4');
  });

  it('circuits: the panel by its tag, else family / type', async () => {
    const f = plant();
    const { state } = await load(f);
    const rows = scheduleRows(cat('circuits'), state.project!, 'm', name, 'lv-1', state.document!.elements, 'en');
    expect(rows.map(r => [r.values.panel, r.values.devices, r.values.load_w])).toEqual([['Panelboard 230/400V', 1, 36]]);
  });
});
