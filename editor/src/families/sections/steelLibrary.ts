/**
 * Steel section library (data in steelSections.ts) plus weight per metre:
 * not tabulated, it follows from the section area (root fillets and rounded
 * corners included) × 7850 kg/m³, the same rule as `bimdown query`.
 */
import { resolveSection } from './registry.ts';
import { STEEL_DENSITY, sectionTypeValues, type SteelSection } from './steelSections.ts';

export * from './steelSections.ts';

/**
 * Weight per metre (kg/m) of a section given as type / element attrs in
 * project units (`upm` per metre); undefined for non-steel materials.
 */
export function steelWeightPerMetre(attrs: Record<string, string>, upm = 1): number | undefined {
  if ((attrs.material || '') !== 'steel' || !attrs.shape) return undefined;
  const { family, params } = resolveSection(attrs.shape, attrs);
  const area = family.area ? family.area(params) : undefined;
  if (area === undefined || !(area > 0)) return undefined;
  return (area / (upm * upm)) * STEEL_DENSITY;
}

/** Weight per metre of a library section (kg/m). */
export function librarySectionWeight(s: SteelSection): number {
  return steelWeightPerMetre(sectionTypeValues(s)) ?? 0;
}
