/**
 * Lookup helper for `ElementModule.toolbarVariants`.
 *
 * When a module declares multiple toolbar variants (e.g. foundation →
 * isolated/strip/raft), the variant id is carried through
 * `state.drawingTarget.variantId`. The drawing tools call `variantDefaults()`
 * to fetch any attrs the variant wants merged into the new element's attrs,
 * sitting between the module's `defaults` and the user's live `drawingAttrs`:
 *
 *   { ...module.defaults, ...variant.defaults, ...drawingAttrs }
 *
 * Returns an empty object when the table doesn't declare variants or the
 * variant id isn't recognized — that path is what all non-variant modules
 * hit, so callers don't need to branch.
 */
import { getElementModule } from '../elements/registry.ts';

export function variantDefaults(tableName: string, variantId: string | undefined): Record<string, string> {
  if (!variantId) return {};
  const mod = getElementModule(tableName);
  const variant = mod?.toolbarVariants?.find(v => v.id === variantId);
  return variant?.defaults ?? {};
}
