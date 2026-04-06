import type { CanonicalElement, LineElement } from '../../model/elements.ts';
import type { BimPrimitive } from '../primitives/types.ts';
import { buildSlabPrimitive } from './slabBuilder.ts';
import { buildRoofPrimitive } from './roofBuilder.ts';
import { buildSpacePrimitive } from './spaceBuilder.ts';
import { buildWallPrimitive } from './wallBuilder.ts';
import { buildBeamPrimitive } from './beamBuilder.ts';
import { buildMepPrimitive } from './mepBuilder.ts';
import { buildColumnPrimitive } from './columnBuilder.ts';
import { buildCurtainWallPrimitive } from './curtainWallBuilder.ts';
import { buildStairPrimitive } from './stairBuilder.ts';
import { buildRailingPrimitive } from './railingBuilder.ts';
import { buildDoorWindowPrimitive } from './doorWindowBuilder.ts';
import { buildEquipmentPrimitive, buildRampPrimitive } from './equipmentBuilder.ts';

export interface BuildContext {
  levelElevation: number;
  levelElevations: Map<string, number>;
  allElements?: Map<string, CanonicalElement>;
  /** Pre-collected wall line elements on current level (for hosted-element spatial matching). */
  wallsOnLevel?: LineElement[];
}

/**
 * Dispatcher: builds geometric primitives from a single CanonicalElement.
 * Returns an empty array for element types not yet migrated to the builder pipeline
 * (legacy Layer components continue to handle those).
 */
export function buildPrimitives(
  element: CanonicalElement,
  ctx: BuildContext,
): BimPrimitive[] {
  const result: BimPrimitive[] = [];
  const { levelElevation, levelElevations, allElements, wallsOnLevel } = ctx;

  switch (element.tableName) {
    case 'slab':
    case 'structure_slab':
    case 'foundation':
    case 'ceiling': {
      const p = buildSlabPrimitive(element, levelElevation, allElements);
      if (p) result.push(p);
      break;
    }
    case 'roof': {
      const p = buildRoofPrimitive(element, levelElevation);
      if (p) result.push(p);
      break;
    }
    case 'space': {
      const p = buildSpacePrimitive(element, levelElevation, levelElevations);
      if (p) result.push(p);
      break;
    }
    case 'wall':
    case 'structure_wall': {
      const p = buildWallPrimitive(element, levelElevation, levelElevations, allElements, wallsOnLevel ?? []);
      if (p) result.push(p);
      break;
    }
    case 'beam':
    case 'brace': {
      const p = buildBeamPrimitive(element, levelElevation);
      if (p) result.push(p);
      break;
    }
    case 'pipe':
    case 'duct':
    case 'conduit':
    case 'cable_tray': {
      const p = buildMepPrimitive(element, levelElevation);
      if (p) result.push(p);
      break;
    }
    case 'column':
    case 'structure_column': {
      const p = buildColumnPrimitive(element, levelElevation, levelElevations);
      if (p) result.push(p);
      break;
    }
    case 'curtain_wall': {
      const p = buildCurtainWallPrimitive(element, levelElevation, levelElevations);
      if (p) result.push(p);
      break;
    }
    case 'stair': {
      const p = buildStairPrimitive(element);
      if (p) result.push(p);
      break;
    }
    case 'railing': {
      const p = buildRailingPrimitive(element, levelElevation);
      if (p) result.push(p);
      break;
    }
    case 'door':
    case 'window': {
      const p = buildDoorWindowPrimitive(element, levelElevation);
      if (p) result.push(p);
      break;
    }
    case 'equipment':
    case 'terminal':
    case 'mep_node': {
      const p = buildEquipmentPrimitive(element, levelElevation, levelElevations);
      if (p) result.push(p);
      break;
    }
    case 'ramp': {
      const p = buildRampPrimitive(element);
      if (p) result.push(p);
      break;
    }
  }

  return result;
}

