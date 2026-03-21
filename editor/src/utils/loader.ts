import type { CsvRow, Level, FloorData, ProjectData, GridData } from '../types.ts';

const SAMPLE_DATA_BASE = '/sample_data';
const DISCIPLINES = ['architectural', 'structural', 'hvac', 'plumbing', 'electrical'];

function parseCsv(text: string): CsvRow[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseCsvLine(line);
    const row: CsvRow = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] || '';
    }
    rows.push(row);
  }
  return rows;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

async function fetchText(path: string): Promise<string | null> {
  try {
    const resp = await fetch(path);
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

export async function loadProject(): Promise<ProjectData> {
  let levels: Level[] = [];
  for (const disc of DISCIPLINES) {
    const text = await fetchText(`${SAMPLE_DATA_BASE}/${disc}/global/level.csv`);
    if (text) {
      const rows = parseCsv(text);
      levels = rows.map(r => ({
        id: r.id,
        number: r.number || '',
        name: r.name || '',
        elevation: parseFloat(r.elevation) || 0,
      }));
      break;
    }
  }

  levels.sort((a, b) => a.elevation - b.elevation);

  const floors = new Map<string, FloorData>();

  for (const disc of DISCIPLINES) {
    for (const level of levels) {
      const levelDir = `${SAMPLE_DATA_BASE}/${disc}/${level.id}`;
      const tableNames = getTableNamesForDiscipline(disc);

      for (const tableName of tableNames) {
        const svgPath = `${levelDir}/${tableName}s.svg`;
        const csvPath = `${levelDir}/${tableName}.csv`;

        const svgContent = await fetchText(svgPath);
        if (!svgContent) continue;

        const csvContent = await fetchText(csvPath);
        const csvMap = new Map<string, CsvRow>();
        if (csvContent) {
          const rows = parseCsv(csvContent);
          for (const row of rows) {
            if (row.id) csvMap.set(row.id, row);
          }
        }

        if (!floors.has(level.id)) {
          floors.set(level.id, {
            levelId: level.id,
            levelName: level.name || level.id,
            layers: [],
          });
        }

        floors.get(level.id)!.layers.push({
          tableName,
          discipline: disc,
          svgContent,
          csvRows: csvMap,
        });
      }
    }
  }

  return { levels, floors };
}

function getTableNamesForDiscipline(disc: string): string[] {
  switch (disc) {
    case 'architectural':
      return ['wall', 'column', 'door', 'space', 'slab', 'stair', 'terminal'];
    case 'structural':
      return ['structure_wall', 'structure_column', 'structure_slab', 'slab'];
    case 'hvac':
      return ['duct', 'equipment', 'terminal'];
    case 'plumbing':
      return ['pipe', 'equipment', 'terminal'];
    case 'electrical':
      return ['equipment', 'terminal'];
    default:
      return [];
  }
}

export async function loadGrids(): Promise<GridData[]> {
  for (const disc of DISCIPLINES) {
    const text = await fetchText(`${SAMPLE_DATA_BASE}/${disc}/global/grid.csv`);
    if (text) {
      const rows = parseCsv(text);
      return rows.map(r => ({
        id: r.id,
        number: r.number || '',
        x1: parseFloat(r.start_x) || 0,
        y1: parseFloat(r.start_y) || 0,
        x2: parseFloat(r.end_x) || 0,
        y2: parseFloat(r.end_y) || 0,
      }));
    }
  }
  return [];
}
