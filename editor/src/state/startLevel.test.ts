import { describe, it, expect } from 'vitest';
import '../elements/registerAll.ts';
import { loadProject } from '../utils/loader.ts';
import { pickStartLevel } from './startLevel.ts';
import { memoryDataSource, fc } from '../test/memoryDataSource.ts';

const wall = (id: string) => ({
  [`${id}/wall.csv`]: 'id,number,thickness\nw-1,,0.2\n',
  [`${id}/wall.geojson`]: fc([{ type: 'Feature', properties: { id: 'w-1' },
    geometry: { type: 'LineString', coordinates: [[0, 0], [4, 0]] } }]),
});
const footing = (id: string) => ({
  [`${id}/structure_column.csv`]: 'id,number\nc-1,\n',
  [`${id}/structure_column.geojson`]: fc([{ type: 'Feature', properties: { id: 'c-1' },
    geometry: { type: 'Point', coordinates: [0, 0] } }]),
});
const levels = (rows: string) => ({ 'global/level.csv': `id,number,name,elevation\n${rows}` });

describe('pickStartLevel', () => {
  it('skips a foundation level below the ground floor', async () => {
    const p = await loadProject(memoryDataSource({
      ...levels('lv-B1,B1,Footing,-1.25\nlv-1,1,Level 1,0\nlv-2,2,Level 2,3.1\n'),
      ...wall('lv-B1'), ...wall('lv-1'), ...wall('lv-2'),
    }));
    expect(pickStartLevel(p)).toBe('lv-1');
  });

  it('prefers a floor with walls or rooms over one nearer 0 without', async () => {
    const p = await loadProject(memoryDataSource({
      ...levels('lv-0,0,Footing,0\nlv-1,1,Level 1,3\n'),
      ...footing('lv-0'), ...wall('lv-1'),
    }));
    expect(pickStartLevel(p)).toBe('lv-1');
  });

  it('takes the level at or above 0 on a tie and any content when no floor has walls', async () => {
    const tie = await loadProject(memoryDataSource({
      ...levels('lv-a,1,Below,-1.5\nlv-b,2,Above,1.5\n'), ...wall('lv-a'), ...wall('lv-b'),
    }));
    expect(pickStartLevel(tie)).toBe('lv-b');
    const bare = await loadProject(memoryDataSource({
      ...levels('lv-1,1,L1,0\nlv-2,2,L2,3\n'), ...footing('lv-2'),
    }));
    expect(pickStartLevel(bare)).toBe('lv-2');
  });

  it('is empty when no floor has content', async () => {
    const p = await loadProject(memoryDataSource(levels('lv-1,1,L1,0\n')));
    expect(pickStartLevel(p)).toBe('');
  });
});
