import type { Shape2D } from './types.ts';

/**
 * Stable string key for a Shape2D spec.
 * Used to group primitives that share the same profile for instancing.
 */
export function profileKey(spec: Shape2D): string {
  switch (spec.kind) {
    case 'rect':  return `rect:${spec.width}:${spec.depth}`;
    case 'round': return `round:${spec.radius}`;
    case 'i':     return `i:${spec.width}:${spec.depth}:${spec.flange}:${spec.web}:${spec.radius ?? 0}`;
    case 't':     return `t:${spec.width}:${spec.depth}:${spec.flange}:${spec.web}:${spec.radius ?? 0}`;
    case 'l':     return `l:${spec.width}:${spec.depth}:${spec.thickness}:${spec.radius ?? 0}`;
    case 'c':     return `c:${spec.width}:${spec.depth}:${spec.flange}:${spec.web}:${spec.radius ?? 0}`;
    case 'rect_hollow': return `rh:${spec.width}:${spec.depth}:${spec.thickness}:${spec.radius}`;
    case 'round_hollow': return `ch:${spec.radius}:${spec.thickness}`;
    case 'cross': return `cross:${spec.width}:${spec.depth}:${spec.thickness}`;
    case 'shape': return `shape:${spec.shape.uuid}`;
  }
}
