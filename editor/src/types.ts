export interface Level {
  id: string;
  number: string;
  name: string;
  elevation: number;
}

export interface CsvRow {
  [key: string]: string;
}

export interface LayerData {
  tableName: string;
  discipline: string;
  svgContent: string;
  csvRows: Map<string, CsvRow>;
}

export interface FloorData {
  levelId: string;
  levelName: string;
  layers: LayerData[];
}

export interface ProjectData {
  levels: Level[];
  floors: Map<string, FloorData>;
}

export interface GridData {
  id: string;
  number: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type SvgElementType = 'line' | 'rect' | 'polygon' | 'circle' | 'path';

// Re-export LayerStyle type and data from the centralized registry
export type { LayerStyle } from './model/tableRegistry.ts';
export {
  DISCIPLINE_COLORS,
  DISCIPLINES,
  tablesForDiscipline,
  disciplineForTable,
  layerStyleForTable,
  allTableNames,
} from './model/tableRegistry.ts';

// Backward-compatible aliases derived from the registry
import { TABLE_REGISTRY, tablesForDiscipline, disciplineForTable } from './model/tableRegistry.ts';
import type { LayerStyle } from './model/tableRegistry.ts';

export const LAYER_STYLES: Record<string, LayerStyle> = Object.fromEntries(
  Object.entries(TABLE_REGISTRY).map(([name, def]) => [name, def.layerStyle])
);

export const DISCIPLINE_TABLES: Record<string, string[]> = {
  architechture: tablesForDiscipline('architechture'),
  structure:     tablesForDiscipline('structure'),
  mep:           tablesForDiscipline('mep'),
  reference:     tablesForDiscipline('reference'),
};

export const TABLE_TO_DISCIPLINE: Record<string, string> = Object.fromEntries(
  Object.entries(TABLE_REGISTRY).map(([name, def]) => [name, def.discipline])
);

export const ALL_TABLE_NAMES: string[] = Object.keys(TABLE_REGISTRY);
