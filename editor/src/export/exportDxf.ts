import type { ProjectData } from '../types.ts';
import type { CanonicalElement } from '../model/elements.ts';
import { parseFloorLayers } from '../model/parse.ts';
import { triggerDownload } from './download.ts';

// DXF color indices (AutoCAD ACI) — approximate matches to our layer colors
const LAYER_COLORS: Record<string, number> = {
  wall:             18,   // dark blue-gray
  curtain_wall:     4,    // cyan
  column:           8,    // dark gray
  door:             5,    // blue
  window:           4,    // cyan
  slab:             9,    // light gray
  space:            5,    // blue
  stair:            30,   // orange
  structure_wall:   8,    // gray
  structure_column: 9,    // light gray
  structure_slab:   8,    // gray
  beam:             6,    // magenta
  brace:            6,    // magenta
  duct:             4,    // cyan
  pipe:             4,    // cyan
  cable_tray:       3,    // green
  conduit:          3,    // green
  equipment:        1,    // red
  terminal:         30,   // orange
};

const DEFAULT_ACI = 7; // white

export async function exportDxf(project: ProjectData, modelName: string): Promise<void> {
  const DrawingModule = await import('dxf-writer');
  const Drawing = DrawingModule.default;

  const dxf = new Drawing();
  dxf.setUnits('Meters');

  // Collect all table names to create layers
  const allTableNames = new Set<string>();
  for (const [, floor] of project.floors) {
    for (const layer of floor.layers) {
      allTableNames.add(layer.tableName);
    }
  }

  for (const tableName of allTableNames) {
    const color = LAYER_COLORS[tableName] ?? DEFAULT_ACI;
    dxf.addLayer(tableName.toUpperCase(), color, 'CONTINUOUS');
  }

  for (const level of project.levels) {
    const floor = project.floors.get(level.id);
    if (!floor) continue;

    const elements = parseFloorLayers(floor.layers);

    for (const el of elements) {
      dxf.setActiveLayer(el.tableName.toUpperCase());
      drawElement(dxf, el);
    }
  }

  const content = dxf.toDxfString();
  const blob = new Blob([content], { type: 'application/dxf' });
  triggerDownload(blob, `${modelName}.dxf`);
}

function drawElement(dxf: any, el: CanonicalElement): void {
  switch (el.geometry) {
    case 'line':
    case 'spatial_line':
      dxf.drawLine(el.start.x, -el.start.y, el.end.x, -el.end.y);
      break;
    case 'point':
      dxf.drawRect(
        el.position.x - el.width / 2,
        -el.position.y - el.height / 2,
        el.position.x + el.width / 2,
        -el.position.y + el.height / 2,
      );
      break;
    case 'polygon':
      if (el.vertices.length >= 3) {
        const pts: [number, number][] = el.vertices.map(v => [v.x, -v.y]);
        dxf.drawPolyline(pts, true);
      }
      break;
  }
}
