// Side-effect import: registers the built-in section families on load.
import './_builtin.ts';

export type { SectionFamily, SectionParams, SectionParamDef } from './types.ts';
export { getSectionFamily, listSectionFamilies, resolveSection } from './registry.ts';
