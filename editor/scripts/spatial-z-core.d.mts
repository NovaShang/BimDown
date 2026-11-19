export type ZHint = 'n/a' | 'absolute' | 'relative' | 'ambiguous' | 'mixed';

export interface SpatialZChange {
  file: string;
  level: string;
  elevation: number;
  kind: 'lines' | 'points' | 'columns';
  count?: number;
  zMin?: number;
  zMax?: number;
  hint?: ZHint;
  detail: string;
}

export interface SpatialZPlan {
  status: 'skipped' | 'refused' | 'planned';
  reason?: string;
  changes: SpatialZChange[];
  /** [project-relative path, new content]; includes the stamped project_metadata.json */
  writes: [string, string][];
}

export const SPATIAL_LINE_TABLES: string[];
export const SPATIAL_POINT_TABLES: string[];
export const HINT_TEXT: Record<ZHint, string>;
export function isMigrationInput(path: string): boolean;
export function zHint(zs: number[], elevation: number, nextElevation?: number): ZHint;
export function planSpatialZMigration(files: Map<string, string>, opts?: { force?: boolean }): SpatialZPlan;
export function markedMetadata(metaText: string | null | undefined): string;
export function parseCsv(text: string): { header: string[]; rows: string[][] };
export function writeCsv(csv: { header: string[]; rows: string[][] }): string;
