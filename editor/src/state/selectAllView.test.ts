import { describe, it, expect } from 'vitest';
import { isLayerSelectableInView } from './selectors.ts';
import type { EditorState } from './editorTypes.ts';

const state = (activeDiscipline: string, layers: string[]) =>
  ({ activeDiscipline, visibleLayers: new Set(layers), viewOptions: {} }) as unknown as EditorState;

describe('Select All respects the active discipline', () => {
  const layers = ['architecture/wall', 'architecture/space', 'mep/duct', 'structure/structure_column', 'reference/grid'];
  it('MEP view selects only MEP layers', () => {
    const s = state('mep', layers);
    expect(isLayerSelectableInView('mep', 'duct', s)).toBe(true);
    expect(isLayerSelectableInView('architecture', 'wall', s)).toBe(false);
    expect(isLayerSelectableInView('architecture', 'space', s)).toBe(false);
    expect(isLayerSelectableInView('reference', 'grid', s)).toBe(false);
  });
  it('architecture view keeps architecture selectable', () => {
    const s = state('architecture', layers);
    expect(isLayerSelectableInView('architecture', 'wall', s)).toBe(true);
    expect(isLayerSelectableInView('mep', 'duct', s)).toBe(false);
  });
  it('hidden layers are never selected', () => {
    expect(isLayerSelectableInView('mep', 'duct', state('mep', []))).toBe(false);
  });
});
