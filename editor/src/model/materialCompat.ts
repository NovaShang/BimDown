/**
 * Legacy material name → spec canonical enum value mapping.
 * The spec (materialized.yaml) defines: concrete, concrete_precast, steel,
 * aluminum, glass, wood, brick, gypsum, metal_panel, insulation, stone,
 * ceramic, copper, pvc, galvanized_steel.
 *
 * Existing data may use free-text names from Revit. This map normalizes them.
 */
const LEGACY_MAP: Record<string, string> = {
  'default wall': 'gypsum',
  'concrete, cast-in-place': 'concrete',
  'concrete': 'concrete',
  'steel': 'steel',
  'glass': 'glass',
  'brick': 'brick',
  'block': 'concrete',
  'metal stud': 'steel',
  'wood': 'wood',
  'aluminum': 'aluminum',
  'gypsum': 'gypsum',
  'copper': 'copper',
  'pvc': 'pvc',
};

/**
 * Normalize a material value to spec canonical form.
 * Unknown values pass through unchanged (graceful degradation).
 */
export function normalizeMaterial(value: string): string {
  if (!value) return value;
  return LEGACY_MAP[value.toLowerCase()] ?? value;
}
