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

export interface LayerStyle {
  displayName: string;
  color: string;
  icon: string;
  order: number;
}

export const LAYER_STYLES: Record<string, LayerStyle> = {
  wall:             { displayName: 'Walls',            color: '#1a1a2e', icon: '▬', order: 1 },
  structure_wall:   { displayName: 'Str. Walls',       color: '#4a3728', icon: '▬', order: 2 },
  column:           { displayName: 'Columns',          color: '#2d2d2d', icon: '■', order: 3 },
  structure_column: { displayName: 'Str. Columns',     color: '#5c3d2e', icon: '■', order: 4 },
  door:             { displayName: 'Doors',            color: '#0077b6', icon: '▭', order: 5 },
  space:            { displayName: 'Spaces',           color: '#3a86ff', icon: '⬡', order: 6 },
  slab:             { displayName: 'Slabs',            color: '#adb5bd', icon: '▨', order: 7 },
  structure_slab:   { displayName: 'Str. Slabs',       color: '#8d6e63', icon: '▨', order: 8 },
  stair:            { displayName: 'Stairs',           color: '#7b68ee', icon: '⊞', order: 9 },
  duct:             { displayName: 'Ducts',            color: '#00b4d8', icon: '═', order: 10 },
  pipe:             { displayName: 'Pipes',            color: '#06d6a0', icon: '║', order: 11 },
  equipment:        { displayName: 'Equipment',        color: '#e63946', icon: '⚙', order: 12 },
  terminal:         { displayName: 'Terminals',        color: '#f77f00', icon: '◆', order: 13 },
  conduit:          { displayName: 'Conduits',         color: '#ffd166', icon: '│', order: 14 },
  cable_tray:       { displayName: 'Cable Trays',      color: '#ffd166', icon: '╤', order: 15 },
  beam:             { displayName: 'Beams',            color: '#8d6e63', icon: '━', order: 16 },
  brace:            { displayName: 'Braces',           color: '#8d6e63', icon: '╲', order: 17 },
  grid:             { displayName: 'Grids',            color: '#ef476f', icon: '┼', order: 0 },
};

export const DISCIPLINE_COLORS: Record<string, string> = {
  architechture: '#3a86ff',
  structure:     '#e07a2f',
  mep:           '#00b4d8',
};

export const DISCIPLINE_TABLES: Record<string, string[]> = {
  architechture: ['wall', 'column', 'door', 'window', 'space', 'slab', 'stair'],
  structure:     ['structure_wall', 'structure_column', 'structure_slab', 'beam', 'brace', 'isolated_foundation', 'raft_foundation', 'strip_foundation'],
  mep:           ['duct', 'pipe', 'conduit', 'cable_tray', 'equipment', 'terminal', 'mep_node'],
};

export const TABLE_TO_DISCIPLINE: Record<string, string> = Object.fromEntries(
  Object.entries(DISCIPLINE_TABLES).flatMap(([disc, tables]) =>
    tables.map(t => [t, disc])
  )
);

export const ALL_TABLE_NAMES: string[] = Object.values(DISCIPLINE_TABLES).flat();
