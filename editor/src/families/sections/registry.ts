import type { SectionFamily, SectionParams } from './types.ts';

const registry = new Map<string, SectionFamily>();

export function registerSectionFamily(family: SectionFamily): void {
  registry.set(family.id, family);
}

export function getSectionFamily(id: string | undefined): SectionFamily | undefined {
  if (!id) return undefined;
  // Accept both 'i_shape' and the historical 'i' alias.
  return registry.get(id) ?? registry.get(`${id}_shape`);
}

export function listSectionFamilies(): SectionFamily[] {
  return Array.from(registry.values());
}

/** Convenience: resolve a section by id + raw attrs in one call. Falls back to
 *  the 'rect' family when the id is unknown so callers never crash on stale
 *  data. */
export function resolveSection(
  id: string | undefined,
  attrs: Record<string, string>,
): { family: SectionFamily; params: SectionParams } {
  const fam = getSectionFamily(id) ?? getSectionFamily('rect')!;
  return { family: fam, params: fam.resolveParams(attrs) };
}

/** Helper for families: parse a numeric attr with a default fallback. */
export function attrNum(attrs: Record<string, string>, key: string, fallback: number): number {
  const v = parseFloat(attrs[key] ?? '');
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
