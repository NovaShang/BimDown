import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initProject } from './init.js';

const testDir = join(__dirname, 'test-init-dir');

describe('initProject', () => {
  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('creates the required basic folder structure', () => {
    initProject(testDir);
    expect(existsSync(join(testDir, '.bimdown'))).toBe(true);
    expect(existsSync(join(testDir, 'global'))).toBe(true);
    
    // Check level.csv
    const levelContent = readFileSync(join(testDir, 'global', 'level.csv'), 'utf-8');
    expect(levelContent).toContain('lv-1');
    expect(levelContent).toContain('Level 1');

    // Check grid.csv
    const gridContent = readFileSync(join(testDir, 'global', 'grid.csv'), 'utf-8');
    expect(gridContent).toContain('gr-1');
    expect(gridContent).toContain('gr-2');

    // Marks spatial Z as absolute (spec §4.2) so the project is unambiguous
    const meta = JSON.parse(readFileSync(join(testDir, 'project_metadata.json'), 'utf-8'));
    expect(meta.spatial_z).toBe('absolute');

    // Starter type catalog: walls with layers, doors, windows
    expect(readFileSync(join(testDir, 'global', 'wall_type.csv'), 'utf-8')).toContain('wt-concrete-200');
    expect(readFileSync(join(testDir, 'global', 'type_layer.csv'), 'utf-8')).toContain('wt-ext-concrete-eps');
    expect(existsSync(join(testDir, 'global', 'door_type.csv'))).toBe(true);
    expect(existsSync(join(testDir, 'global', 'window_type.csv'))).toBe(true);
    expect(meta.units).toBe('m');
  });

  const row = (file: string, id: string) => {
    const [head, ...rows] = readFileSync(join(testDir, 'global', file), 'utf-8').trim().split('\n');
    const cols = head.split(',');
    const vals = rows.find((r) => r.startsWith(`${id},`))!.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, vals[i]]));
  };

  it('--units mm scales the starter catalog and grid to millimetres', () => {
    initProject(testDir, { units: 'mm' });
    expect(JSON.parse(readFileSync(join(testDir, 'project_metadata.json'), 'utf-8')).units).toBe('mm');
    expect(row('wall_type.csv', 'wt-concrete-200').thickness).toBe('200');
    expect(row('type_layer.csv', 'tl-1')).toMatchObject({ thickness: '200', conductivity: '2.3', seq: '1' });
    expect(row('door_type.csv', 'dt-single-900')).toMatchObject({ width: '900', height: '2100', u_value: '2.0' });
    expect(row('curtain_wall_type.csv', 'cwt-glazed-1500')).toMatchObject({ u_spacing: '1500', mullion_width: '50', shgc: '0.35' });
    expect(readFileSync(join(testDir, 'global', 'grid.csv'), 'utf-8')).toContain('gr-1,A,-10000,0,10000,0');
  });

  it('--units ft converts the metric starter sizes to feet (no metric numbers in a feet project)', () => {
    initProject(testDir, { units: 'ft' });
    expect(JSON.parse(readFileSync(join(testDir, 'project_metadata.json'), 'utf-8')).units).toBe('ft');
    expect(Number(row('wall_type.csv', 'wt-concrete-200').thickness)).toBeCloseTo(0.656168, 5);
    expect(Number(row('door_type.csv', 'dt-single-900').height)).toBeCloseTo(6.889764, 5);
    expect(row('window_type.csv', 'wnt-casement-600x1200').u_value).toBe('1.4');
    expect(readFileSync(join(testDir, 'global', 'grid.csv'), 'utf-8')).toContain('gr-1,A,-30,0,30,0');
  });

  it('rejects unknown units', () => {
    expect(() => initProject(testDir, { units: 'cm' as any })).toThrow(/Unknown units/);
  });
});
