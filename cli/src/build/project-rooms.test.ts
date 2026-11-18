import { describe, it, expect } from 'vitest';
import { deriveLevelRooms, memoryFiles, snapProjectEndpoints } from './project-rooms.js';

const line = (id: string, a: [number, number], b: [number, number]) =>
  ({ type: 'Feature', properties: { id }, geometry: { type: 'LineString', coordinates: [a, b] } });
const fc = (...features: object[]) => JSON.stringify({ type: 'FeatureCollection', features });

describe('project rooms (shared by build and the IFC importer)', () => {
  it('leaves an exact junction alone when one of its ends may not move', () => {
    // A 4 x 4 room whose south-west corner is an exact junction of its west side and a 20 cm
    // stub of the south side; three lines outside meet 4 cm away. Snapping the corner there
    // would turn the stub > 2°, so it stays, and the west side must stay with it.
    const files: Record<string, string> = {
      'project_metadata.json': JSON.stringify({ format_version: '3.0', units: 'm' }),
      'lv-1/room_separator.geojson': fc(
        line('rs-1', [0, 0], [0.2, 0]), line('rs-2', [0.2, 0], [4, 0]), line('rs-3', [4, 0], [4, 4]),
        line('rs-4', [4, 4], [0, 4]), line('rs-5', [0, 4], [0, 0]),
        line('rs-6', [-2, -0.03], [-0.03, -0.03]), line('rs-7', [-0.03, -0.03], [-0.03, -2]), line('rs-8', [-0.03, -0.03], [-1, -1]),
      ),
      'lv-1/space.csv': 'id,number,name,x,y\nsp-1,1,Room,2,2\n',
    };
    const project = memoryFiles(files);
    const snaps = snapProjectEndpoints(project, ['global', 'lv-1']);
    expect(snaps.find(s => s.elementId === 'rs-5')).toBeUndefined();
    const { rooms } = deriveLevelRooms(project, 'lv-1');
    expect(rooms?.roomIssues).toEqual([]);
    expect(rooms?.matched.has('sp-1')).toBe(true);
  });

  it('snaps near-coincident corners and rewrites the files it changed', () => {
    const files: Record<string, string> = {
      'lv-1/wall.geojson': fc(line('w-1', [0, 0], [5, 0]), line('w-2', [5.02, 0.01], [5, 5])),
    };
    const snaps = snapProjectEndpoints(memoryFiles(files), ['lv-1']);
    expect(snaps).toHaveLength(1);
    expect(files['lv-1/wall.geojson']).not.toContain('5.02');
  });
});
