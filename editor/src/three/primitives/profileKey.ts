import type { Shape2D } from './types.ts';

/**
 * Stable string key for a Shape2D spec.
 * Used to group primitives that share the same profile for instancing.
 */
export function profileKey(spec: Shape2D): string {
  switch (spec.kind) {
    case 'rect':  return `rect:${spec.width}:${spec.depth}`;
    case 'round': return `round:${spec.radius}`;
    case 'i':     return `i:${spec.width}:${spec.depth}:${spec.flange}:${spec.web}`;
    case 't':     return `t:${spec.width}:${spec.depth}:${spec.flange}:${spec.web}`;
    case 'l':     return `l:${spec.width}:${spec.depth}:${spec.thickness}`;
    case 'c':     return `c:${spec.width}:${spec.depth}:${spec.flange}:${spec.web}`;
    case 'cross': return `cross:${spec.width}:${spec.depth}:${spec.thickness}`;
    case 'shape': return `shape:${spec.shape.uuid}`;
  }
}
