const GEOMETRY_ORDER: Record<string, number> = { polygon: 0, line: 1, spatial_line: 1, point: 2 };

/**
 * Areas under lines under points within a layer, so a click on a small element
 * inside a large one of the same table (a pile in its pile cap) picks the small
 * one. Layers of one geometry keep their order.
 */
export function pickOrder<T extends { geometry: string }>(elements: T[]): T[] {
  const first = elements[0]?.geometry;
  if (elements.every(e => e.geometry === first)) return elements;
  return elements.map((e, i) => [e, i] as const)
    .sort((a, b) => (GEOMETRY_ORDER[a[0].geometry] ?? 1) - (GEOMETRY_ORDER[b[0].geometry] ?? 1) || a[1] - b[1])
    .map(([e]) => e);
}
