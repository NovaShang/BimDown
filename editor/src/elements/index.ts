export type {
  Archetype,
  ElementModule,
  AnyElementModule,
  GeometryContext,
  Draw2DContext,
  Draw3DContext,
  HitZone,
  Bounds,
} from './archetypes.ts';

export {
  registerElement,
  getElementModule,
  hasElementModule,
  allElementModules,
  elementModulesByArchetype,
  elementModulesByDiscipline,
  csvOnlyTables,
  dualModeTables,
  geometryTypeOf,
  placementTypeOf,
} from './registry.ts';

export {
  PROPERTY_FIELD_DEFS,
  PROPERTY_GROUPS,
  resolvePropertyFields,
} from './_propertyFields.ts';
export type { PropertyField, PropertyGroup } from './_propertyFields.ts';
