import { describe, it, expect } from 'vitest';
import { formatMepSize, parseSizeText, sizeFromDisplay, sizeOptions, sizeSeries, sizeToDisplay, upToSeries, ROUND_DUCT_MM } from './sizes.ts';
import { sizeFieldText } from './MepSizeInput.tsx';
import { mepTypeName } from './mepTypes.ts';
import { sizeDuct, sizePipe } from './calc.ts';
import type { CanonicalElement } from '../model/elements.ts';

describe('MEP sizes', () => {
  it('format in mm / DN / de / inches', () => {
    expect(formatMepSize('pipe', 'round', 0.065, 0)).toBe('DN65');
    expect(formatMepSize('pipe', 'round', 0.015, 0)).toBe('DN15');
    expect(formatMepSize('pipe', 'round', 0.11, 0, { material: 'pvc' })).toBe('de110');
    expect(formatMepSize('duct', 'rect', 0.35, 0.25)).toBe('350×250');
    expect(formatMepSize('duct', 'round', 0.315, 0)).toBe('Ø315');
    expect(formatMepSize('pipe', 'round', 0.065, 0, { unit: 'ft' })).toBe('2-1/2"');
  });

  it('show field values in mm (DN for pipes), project units respected', () => {
    expect(sizeFieldText('pipe', 'size_x', {}, '0.065', 'm')).toBe('DN65');
    expect(sizeFieldText('duct', 'size_x', { shape: 'rect' }, '0.35', 'm')).toBe('350');
    expect(sizeFieldText('duct', 'size_y', { shape: 'rect' }, '250', 'mm')).toBe('250');
    expect(sizeToDisplay(1, 'ft')).toBe(12);
  });

  it('parse typed sizes back to project units', () => {
    expect(sizeFromDisplay(parseSizeText('DN65', 'm')!, 'm')).toBe(0.065);
    expect(sizeFromDisplay(parseSizeText('400', 'm')!, 'm')).toBe(0.4);
    expect(sizeFromDisplay(parseSizeText('Ø250', 'mm')!, 'mm')).toBe(250);
    expect(parseSizeText('1-1/2"', 'in')).toBe(1.5);
    expect(parseSizeText('abc', 'm')).toBeNull();
  });

  it('offer the standard series by table, shape and material', () => {
    expect(sizeSeries('duct', 'size_x', 'round')).toBe(ROUND_DUCT_MM);
    expect(sizeOptions('pipe', 'size_x', 'round', 'ppr', 'm').slice(0, 3).map(o => o.label)).toEqual(['de16', 'de20', 'de25']);
    expect(sizeOptions('pipe', 'size_x', 'round', '', 'm').find(o => o.label === 'DN65')?.value).toBe(0.065);
    expect(upToSeries(301, ROUND_DUCT_MM)).toBe(315);
  });

  it('sizing snaps to the series (round duct, plastic pipe by its bore)', () => {
    expect(ROUND_DUCT_MM).toContain(Math.round(sizeDuct(400, 'round', 0)!.sizeX * 1000));
    const metal = sizePipe(2)!, plastic = sizePipe(2, 'ppr')!;
    expect(metal.sizeX).toBe(0.05);
    expect(plastic.sizeX).toBeGreaterThan(0.05); // de63: the bore of de50 is too small
  });
});

describe('MEP type names', () => {
  const el = (tableName: string, attrs: Record<string, string>) => ({ id: 'x', tableName, attrs } as unknown as CanonicalElement);
  it('group equipment by family / type, runs and accessories by size', () => {
    expect(mepTypeName(el('equipment', { family: 'Pump - Inline', type: 'Standard' }))).toBe('Pump - Inline: Standard');
    expect(mepTypeName(el('equipment', { equipment_type: 'cooling_tower' }))).toBe('Cooling Tower');
    expect(mepTypeName(el('pipe', { shape: 'round', size_x: '0.065', material: 'steel' }))).toBe('Pipe DN65 Steel');
    expect(mepTypeName(el('duct', { shape: 'rect', size_x: '400', size_y: '300', flexible: 'true' }), undefined, 1000)).toBe('Duct 400×300 Flexible');
    expect(mepTypeName(el('mep_node', { kind: 'gate_valve', shape: 'round', size_w: '0.065' }))).toBe('Gate Valve DN65');
    expect(mepTypeName(el('mep_node', { kind: '' }), { kind: 'elbow', table: 'duct', shape: 'rect', sizeX: 0.4, sizeY: 0.3 })).toBe('Duct Elbow 400×300');
    expect(mepTypeName(el('wall', {}))).toBeNull();
  });
});
