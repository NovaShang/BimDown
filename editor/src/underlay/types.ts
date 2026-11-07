// Underlays: reference drawings (image, PDF page, DXF) placed under a level
// for tracing. Stored as files in `underlays/` plus one row each in
// `global/underlay.csv` (spec: csv-schema/underlay.yaml). Not building
// elements — they live outside the document model and its undo history.

export type UnderlayKind = 'image' | 'pdf' | 'dxf';

export interface Underlay {
  id: string;
  name: string;
  levelId: string;
  /** Project-relative path, `underlays/<file>` */
  file: string;
  /** PDF page (1-based) */
  page: number;
  /** Plan position of the file's local origin */
  x: number;
  y: number;
  /** Counter-clockwise, degrees, about the local origin */
  rotation: number;
  /** Project units per local unit (pixel / PDF point / DXF unit) */
  scale: number;
  opacity: number;
  visible: boolean;
  locked: boolean;
  /** DXF layers turned off */
  hiddenLayers: string[];
}

export const UNDERLAY_CSV = 'global/underlay.csv';
export const UNDERLAY_DIR = 'underlays/';
/** Largest file we import (the cloud API stores up to 25 MB per binary file). */
export const MAX_UNDERLAY_BYTES = 25 * 1024 * 1024;
export const UNDERLAY_ACCEPT = '.png,.jpg,.jpeg,.webp,.pdf,.dxf';

const KIND_BY_EXT: Record<string, UnderlayKind> = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image',
  '.pdf': 'pdf', '.dxf': 'dxf',
};

export function underlayKind(file: string): UnderlayKind | null {
  const i = file.lastIndexOf('.');
  return i === -1 ? null : KIND_BY_EXT[file.slice(i).toLowerCase()] ?? null;
}

export const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};
