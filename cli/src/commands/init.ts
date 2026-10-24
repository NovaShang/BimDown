import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function initProject(absDir: string) {
  if (!existsSync(absDir)) {
    mkdirSync(absDir, { recursive: true });
  }

  // Write marking file
  writeFileSync(join(absDir, '.bimdown'), '', 'utf-8');

  // project_metadata.json with current format_version
  const metadataPath = join(absDir, 'project_metadata.json');
  if (!existsSync(metadataPath)) {
    writeFileSync(
      metadataPath,
      JSON.stringify({ format_version: 2, units: 'm' }, null, 2) + '\n',
      'utf-8',
    );
  }

  // Create global dir
  const globalDir = join(absDir, 'global');
  if (!existsSync(globalDir)) {
    mkdirSync(globalDir, { recursive: true });
  }

  // Create level.csv
  const levelCsvPath = join(globalDir, 'level.csv');
  if (!existsSync(levelCsvPath)) {
    writeFileSync(levelCsvPath, 'id,number,name,elevation\nlv-1,1,Level 1,0.0\n', 'utf-8');
  }

  // Create grid.csv
  const gridCsvPath = join(globalDir, 'grid.csv');
  if (!existsSync(gridCsvPath)) {
    // 2 axes (mutually perpendicular), 20 units long in the default unit (m)
    const gridContent = [
      'id,number,start_x,start_y,end_x,end_y',
      'gr-1,A,-10,0,10,0',
      'gr-2,1,0,-10,0,10'
    ].join('\n') + '\n';
    writeFileSync(gridCsvPath, gridContent, 'utf-8');
  }

  console.log(`Initialized empty BimDown project at ${absDir}`);
  console.log('Created:');
  console.log('  - global/level.csv (lv-1)');
  console.log('  - global/grid.csv (A, 1)');
}
