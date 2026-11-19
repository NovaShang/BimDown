#!/usr/bin/env node
/**
 * Migrate hosted element position from 0-1 parametric to meters.
 * Reads wall geometry from SVG, then updates door/window/opening CSVs.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const SAMPLE_DIR = join(import.meta.dirname, '../sample_data/merged');
const HOSTED_TABLES = ['door', 'window', 'opening'];

function parseWallSvg(svgPath) {
  const content = readFileSync(svgPath, 'utf-8');
  const walls = new Map();
  const lineRe = /<line\s+id="([^"]+)"\s+x1="([^"]+)"\s+y1="([^"]+)"\s+x2="([^"]+)"\s+y2="([^"]+)"/g;
  let m;
  while ((m = lineRe.exec(content)) !== null) {
    const [, id, x1, y1, x2, y2] = m;
    const dx = parseFloat(x2) - parseFloat(x1);
    const dy = parseFloat(y2) - parseFloat(y1);
    const len = Math.sqrt(dx * dx + dy * dy);
    walls.set(id, len);
  }
  return walls;
}

function parseCsv(text) {
  const lines = text.split('\n').filter(l => l.trim());
  const header = lines[0].split(',');
  const rows = lines.slice(1).map(line => {
    const values = line.split(',');
    const row = {};
    header.forEach((h, i) => { row[h] = values[i] ?? ''; });
    return row;
  });
  return { header, rows };
}

function serializeCsv(header, rows) {
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(header.map(h => row[h] ?? '').join(','));
  }
  return lines.join('\n') + '\n';
}

// Also check structure_wall.svg
function getWallMap(levelDir) {
  const walls = new Map();
  for (const name of ['wall.svg', 'structure_wall.svg']) {
    const svgPath = join(levelDir, name);
    if (existsSync(svgPath)) {
      for (const [id, len] of parseWallSvg(svgPath)) {
        walls.set(id, len);
      }
    }
  }
  return walls;
}

const levels = readdirSync(SAMPLE_DIR).filter(d => d.startsWith('lv-'));
let totalConverted = 0;

for (const level of levels) {
  const levelDir = join(SAMPLE_DIR, level);
  const walls = getWallMap(levelDir);
  if (walls.size === 0) continue;

  for (const table of HOSTED_TABLES) {
    const csvPath = join(levelDir, `${table}.csv`);
    if (!existsSync(csvPath)) continue;

    const text = readFileSync(csvPath, 'utf-8');
    const { header, rows } = parseCsv(text);
    if (!header.includes('position') || !header.includes('host_id')) continue;

    let changed = 0;
    for (const row of rows) {
      const pos = parseFloat(row.position);
      const hostId = row.host_id;
      if (isNaN(pos) || !hostId) continue;

      const wallLen = walls.get(hostId);
      if (wallLen == null) {
        console.warn(`  [WARN] ${level}/${table}: host ${hostId} not found in SVG`);
        continue;
      }

      // Convert 0-1 parametric to meters
      const meters = pos * wallLen;
      row.position = meters.toFixed(3);
      changed++;
    }

    if (changed > 0) {
      writeFileSync(csvPath, serializeCsv(header, rows));
      console.log(`  ${level}/${table}.csv: converted ${changed} positions (wall count: ${walls.size})`);
      totalConverted += changed;
    }
  }
}

console.log(`\nDone. Converted ${totalConverted} position values.`);
