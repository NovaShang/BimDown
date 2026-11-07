import { describe, it, expect } from 'vitest';
import { MEP_SYSTEM_PRESETS, systemPreset, defaultSystemColor, presetSystemRows, usedSystemCodes } from './systemPresets.ts';
import { resolveMepSystemColor } from '../elements/_mepLineShared.tsx';
import type { SystemDef } from '../types.ts';
import { loadProject } from '../utils/loader.ts';
import { files } from '../test/annotationFixture.ts';

/** sRGB hex → CIELAB (D65). */
function lab(hex: string): [number, number, number] {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const x = (0.4124 * c[0] + 0.3576 * c[1] + 0.1805 * c[2]) / 0.95047;
  const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const z = (0.0193 * c[0] + 0.1192 * c[1] + 0.9505 * c[2]) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

const sys = (system_type: string, color = '', id = ''): SystemDef => ({ id, system_type, name: '', color, discipline: 'hvac' });

describe('MEP system presets', () => {
  it('covers the common codes and the codes the equipment starters emit', () => {
    for (const code of ['SA', 'RA', 'OA', 'EA', 'CHWS', 'CHWR', 'HWS', 'HWR', 'CWS', 'CWR', 'DCW', 'DHW', 'SAN', 'VENT', 'STORM', 'FP', 'PWR', 'LTG', 'DATA',
      'DHWS', 'DHWR', 'V', 'CD', 'G']) {
      expect(systemPreset(code), code).toBeDefined();
    }
    expect(systemPreset('dhws')!.code).toBe('DHW');
    expect(new Set(MEP_SYSTEM_PRESETS.map(p => p.discipline))).toEqual(new Set(['hvac', 'plumbing', 'fire', 'electrical', 'data']));
  });

  it('every preset has its own, visibly different colour', () => {
    const colors = MEP_SYSTEM_PRESETS.map(p => p.color.toLowerCase());
    expect(new Set(colors).size).toBe(colors.length);
    for (const c of colors) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    // CIE76 distance between any two presets
    let min = Infinity;
    for (let i = 0; i < colors.length; i++) {
      for (let j = i + 1; j < colors.length; j++) {
        const a = lab(colors[i]), b = lab(colors[j]);
        min = Math.min(min, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
      }
    }
    expect(min).toBeGreaterThan(15);
  });

  it('un-coloured systems resolve to their preset colour; the project colour still wins', () => {
    expect(resolveMepSystemColor('SA')).toBe(systemPreset('SA')!.color);
    expect(resolveMepSystemColor('RA')).not.toBe(resolveMepSystemColor('SA'));
    expect(resolveMepSystemColor('V')).toBe(systemPreset('VENT')!.color);
    expect(resolveMepSystemColor('SA', '#123456')).toBe('#123456');
  });

  it('a new system defaults to its preset colour, else the next unused colour', () => {
    expect(defaultSystemColor('chws', [])).toBe(systemPreset('CHWS')!.color);
    const first = defaultSystemColor('XYZ', []);
    expect(first).toBe(MEP_SYSTEM_PRESETS[0].color);
    expect(defaultSystemColor('XYZ', [sys('SA', first)])).toBe(MEP_SYSTEM_PRESETS[1].color);
  });

  it('adds picked presets as mep_system rows, skipping existing codes and using the alias the model uses', () => {
    const existing = [sys('SA', '#000000', 'sys-1'), sys('CHWS', '', 'sys-3')];
    const used = usedSystemCodes([{ attrs: { system_type: 'DCW,DHWS,SAN' } }, { attrs: { system_type: '' } }]);
    expect([...used].sort()).toEqual(['DCW', 'DHWS', 'SAN']);
    const rows = presetSystemRows(['SA', 'RA', 'DHW', 'VENT', 'NOPE'], existing, used, 'zh');
    expect(rows).toEqual([
      { id: 'sys-2', system_type: 'RA', name: '回风', color: systemPreset('RA')!.color, discipline: 'hvac' },
      { id: 'sys-4', system_type: 'DHWS', name: '生活热水', color: systemPreset('DHW')!.color, discipline: 'plumbing' },
      { id: 'sys-5', system_type: 'VENT', name: '通气', color: systemPreset('VENT')!.color, discipline: 'plumbing' },
    ]);
    // An alias already in the project counts as the system
    expect(presetSystemRows(['DHW'], [sys('DHWS')], new Set(), 'en')).toEqual([]);
  });

  it('systems found on elements but not declared get the preset discipline and colour', async () => {
    const f = files();
    f['global/mep_system.csv'] = 'id,system_type,name,color,discipline\nsys-1,SA,Supply Air,,hvac\n';
    f['lv-1/duct.csv'] = 'id,shape,size_x,size_y,system_type\ndu-1,rect,0.4,0.3,SA\ndu-2,rect,0.4,0.3,RA\n';
    f['lv-1/duct.geojson'] = JSON.stringify({ type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { id: 'du-1' }, geometry: { type: 'LineString', coordinates: [[0, 1, 3], [4, 1, 3]] } },
      { type: 'Feature', properties: { id: 'du-2' }, geometry: { type: 'LineString', coordinates: [[0, 2, 3], [4, 2, 3]] } },
    ] });
    f['lv-1/pipe.csv'] = 'id,shape,size_x,system_type\npi-1,round,0.05,XYZ\n';
    f['lv-1/pipe.geojson'] = JSON.stringify({ type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { id: 'pi-1' }, geometry: { type: 'LineString', coordinates: [[0, 3, 3], [4, 3, 3]] } },
    ] });
    const { memoryDataSource } = await import('../test/memoryDataSource.ts');
    const project = await loadProject(memoryDataSource(f));
    const by = Object.fromEntries(project.mepSystems.map(s => [s.system_type, s]));
    expect(by.RA).toMatchObject({ name: 'RA', color: systemPreset('RA')!.color, discipline: 'hvac' });
    expect(by.XYZ.color).not.toBe(by.RA.color);
    expect(by.XYZ.color).not.toBe(systemPreset('SA')!.color);
    expect(MEP_SYSTEM_PRESETS.map(p => p.color)).toContain(by.XYZ.color);
  });
});
