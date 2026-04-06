import { registerRenderer } from './index.ts';
import SurfaceRenderer from '../layers/SurfaceRenderer.tsx';
import PathRenderer from '../layers/PathRenderer.tsx';
import InstanceRenderer from '../layers/InstanceRenderer.tsx';
import UnifiedRenderer from '../layers/UnifiedRenderer.tsx';


// Composite-producing tables — use unified renderer (handles mixed primitive kinds)
for (const t of ['curtain_wall', 'stair', 'railing'])
  registerRenderer(t, { component: UnifiedRenderer });

// Surface primitives — walls, slabs, foundations, ceiling, roof, space
for (const t of [
  'wall', 'structure_wall',
  'slab', 'structure_slab', 'foundation', 'ceiling', 'roof', 'space',
])
  registerRenderer(t, { component: SurfaceRenderer });

// Path primitives — beams, braces, MEP runs (profile-aware sweeps)
for (const t of ['beam', 'brace', 'pipe', 'duct', 'conduit', 'cable_tray'])
  registerRenderer(t, { component: PathRenderer });

// Instance primitives — columns, doors, windows, equipment, terminals, ramps
for (const t of [
  'column', 'structure_column',
  'door', 'window',
  'equipment', 'terminal', 'mep_node',
  'ramp',
])
  registerRenderer(t, { component: InstanceRenderer });
