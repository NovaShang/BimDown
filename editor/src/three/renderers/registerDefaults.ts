import { registerRenderer } from './index.ts';
import WallExtrusions from '../layers/WallExtrusions.tsx';
import SpaceWireframes from '../layers/SpaceWireframes.tsx';
import BoxInstances from '../layers/BoxInstances.tsx';
import PolygonExtrusions from '../layers/PolygonExtrusions.tsx';

// Walls — miter-joined extrusions
for (const t of ['wall', 'curtain_wall', 'structure_wall'])
  registerRenderer(t, { component: WallExtrusions });

// Space — wireframe only
registerRenderer('space', { component: SpaceWireframes });

// Box elements — instanced meshes, grouped by material
for (const t of [
  'door', 'window', 'column', 'structure_column',
  'duct', 'pipe', 'conduit', 'cable_tray', 'beam', 'brace',
  'equipment', 'terminal', 'mep_node',
  'ramp', 'railing', 'stair',
])
  registerRenderer(t, { component: BoxInstances, groupByMaterial: true });

// Polygon extrusions — slabs, foundations (raft subtype)
for (const t of ['slab', 'structure_slab', 'foundation'])
  registerRenderer(t, { component: PolygonExtrusions });
