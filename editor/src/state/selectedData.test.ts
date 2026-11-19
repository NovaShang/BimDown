import { describe, it, expect } from 'vitest';
import { load, files } from '../test/annotationFixture.ts';
import { fc } from '../test/memoryDataSource.ts';
import { getSelectedElementData } from './selectors.ts';

describe('properties of a spatial line', () => {
  it('show Start Z / End Z from the geometry when the row has none', async () => {
    const f = files();
    f['lv-1/duct.csv'] = 'id,number,shape,size_x,size_y,system_type\ndu-1,,rect,0.4,0.3,SA\n';
    f['lv-1/duct.geojson'] = fc([{ type: 'Feature', properties: { id: 'du-1' }, geometry: { type: 'LineString', coordinates: [[0, 0, 2.7], [4, 0, 3.1]] } }]);
    const { state } = await load(f);
    const data = getSelectedElementData({ ...state, selectedIds: new Set(['lv-1:du-1']) });
    expect(data.get('lv-1:du-1')!.csv).toMatchObject({ start_z: '2.7', end_z: '3.1' });
  });
});
