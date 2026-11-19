/** Test fixture: a 10 × 5 m room (walls 0.2) with a door, a room seed, a
 *  dimension between the east and west walls, a pinned door tag, an unpinned
 *  room tag and a text note — loaded into a document through rootReducer. */
import '../elements/registerAll.ts';
import { loadProject } from '../utils/loader.ts';
import { parseFloorLayers } from '../model/parse.ts';
import { createDocument } from '../model/document.ts';
import { initialState } from '../state/editorReducer.ts';
import { rootReducer } from '../state/EditorContext.tsx';
import type { EditorState } from '../state/editorTypes.ts';
import { memoryDataSource, fc } from './memoryDataSource.ts';

const line = (id: string, a: number[], b: number[]) => ({
  type: 'Feature', properties: { id }, geometry: { type: 'LineString', coordinates: [a, b] },
});

/** 10 × 5 room, walls 0.2 thick, a door on w-1, a room, a dimension, a pinned + an unpinned tag. */
export function files(): Record<string, string> {
  return {
    'project_metadata.json': JSON.stringify({ format_version: 2, units: 'm', spatial_z: 'absolute' }),
    'global/level.csv': 'id,number,name,elevation\nlv-1,1,L1,0\n',
    'lv-1/wall.csv': 'id,number,thickness\nw-1,,0.2\nw-2,,0.2\nw-3,,0.2\nw-4,,0.2\n',
    'lv-1/wall.geojson': fc([
      line('w-1', [0, 0], [10, 0]), line('w-2', [10, 0], [10, 5]),
      line('w-3', [10, 5], [0, 5]), line('w-4', [0, 5], [0, 0]),
    ]),
    'lv-1/door.csv': 'id,number,host_id,position,width,height\nd-1,D01,w-1,2,0.9,2.1\n',
    'lv-1/space.csv': 'id,number,x,y,name\nsp-1,101,5,2.5,Office\n',
    'lv-1/dimension.csv': 'id,start_x,start_y,end_x,end_y,start_ref,end_ref,direction,offset,text\n'
      + 'dm-1,0,2.5,10,2.5,w-4,w-2,0,-1,\n',
    'lv-1/tag.csv': 'id,host_id,x,y,content\ntg-1,sp-1,,,auto\ntg-2,d-1,2,-1.5,number\n',
    'lv-1/text_note.csv': 'id,x,y,text,size,rotation\ntx-1,5,7,North wing,0.3,0\n',
  };
}

export async function load(f = files()) {
  const ds = memoryDataSource(f);
  const project = await loadProject(ds);
  const floor = project.floors.get('lv-1')!;
  const document = createDocument('lv-1', parseFloorLayers(floor.layers));
  let state: EditorState = { ...initialState, project, currentLevel: 'lv-1' };
  state = rootReducer(state, { type: 'INIT_DOCUMENT', document });
  return { ds, state };
}

