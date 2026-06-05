import type { CsvRow, Level, FloorData, ProjectData, GridData, LayerData, ProjectMetadata, ProjectUnit, SystemDef } from '../types.ts';
import { DISCIPLINE_TABLES, TABLE_TO_DISCIPLINE } from '../types.ts';
import type { DataSource } from './dataSource.ts';

const VALID_UNITS: ReadonlySet<ProjectUnit> = new Set(['m', 'ft', 'in', 'mm']);

const DEFAULT_METADATA: ProjectMetadata = { format_version: '3.0', units: 'm' };

function normalizeUnits(raw: unknown): ProjectUnit {
  if (typeof raw === 'string' && VALID_UNITS.has(raw as ProjectUnit)) {
    return raw as ProjectUnit;
  }
  // Tolerate legacy "meters" spelling that used to be the default.
  if (raw === 'meters') return 'm';
  return 'm';
}

export async function loadProjectMetadata(ds: DataSource): Promise<ProjectMetadata> {
  const text = await ds.fetchText('project_metadata.json');
  if (!text) return { ...DEFAULT_METADATA };
  try {
    const json = JSON.parse(text);
    return {
      format_version: json.format_version ?? '3.0',
      project_name: json.project_name,
      units: normalizeUnits(json.units),
      source: json.source,
    };
  } catch {
    return { ...DEFAULT_METADATA };
  }
}

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

/**
 * Spatial elements (duct/pipe/beam… and the 3D points equipment/terminal/mep_node)
 * carry **absolute** Z in their GeoJSON coordinates per the BimDown spec. The
 * editor, however, renders spatial Z as **level-relative** (`levelElevation + z`,
 * and its draw defaults like `start_z: '3'` mean "3 m above the floor"). So when a
 * project comes from an absolute-Z source (e.g. a Revit export) we convert each
 * LEVEL layer's Z to the editor's relative convention by subtracting the level
 * elevation:
 *   - LineString coords (duct/pipe/…): `z -= elevation` (consumed as startZ/endZ).
 *   - Point coords (equipment/terminal/mep_node): the relative Z is written into
 *     the CSV `base_offset` — `buildPoint` reads `base_offset`, not `coords[2]`,
 *     so without this the point collapses to the floor plane.
 * Level-anchored elements (walls/columns/slabs) have 2D coords and are untouched.
 * Global-directory layers are rendered at elevation 0, so their absolute Z is
 * already correct and is NOT normalized here.
 */
function normalizeLevelLayerZ(
  geojsonContent: string,
  elevation: number,
  csvMap: Map<string, CsvRow>,
): string {
  if (!geojsonContent) return geojsonContent;
  let fc: { features?: { geometry?: { type?: string; coordinates?: unknown }; properties?: { id?: string } }[] };
  try { fc = JSON.parse(geojsonContent); } catch { return geojsonContent; }
  if (!Array.isArray(fc.features)) return geojsonContent;
  for (const ft of fc.features) {
    const g = ft.geometry;
    if (!g) continue;
    if (g.type === 'Point') {
      const c = g.coordinates as number[];
      if (Array.isArray(c) && c.length >= 3 && typeof c[2] === 'number') {
        const relZ = c[2] - elevation;
        c[2] = relZ;
        const id = ft.properties?.id;
        if (id) {
          const row = csvMap.get(id) ?? { id };
          if (row.base_offset === undefined || row.base_offset === '') {
            row.base_offset = String(relZ);
            csvMap.set(id, row);
          }
        }
      }
    } else if (g.type === 'LineString') {
      const coords = g.coordinates as number[][];
      if (Array.isArray(coords)) {
        for (const c of coords) {
          if (Array.isArray(c) && c.length >= 3 && typeof c[2] === 'number') c[2] = c[2] - elevation;
        }
      }
    }
  }
  return JSON.stringify(fc);
}

export async function loadProject(ds: DataSource): Promise<ProjectData> {
  const metadataPromise = loadProjectMetadata(ds);
  const manifest = ds.listFiles ? new Set(await ds.listFiles()) : null;
  const fetchIfPresent = (p: string) =>
    manifest && !manifest.has(p) ? Promise.resolve(null) : ds.fetchText(p);

  // Absolute-Z sources (Revit) store absolute Z in coords; the editor model is
  // level-relative. Normalize level layers on import (see normalizeLevelLayerZ).
  const metadata = await metadataPromise;
  const isAbsoluteZ = /revit/i.test(metadata.source ?? '');

  let levels: Level[] = [];
  const text = await fetchIfPresent('global/level.csv');
  if (text) {
    const rows = parseCsv(text);
    levels = rows.map(r => ({
      id: r.id,
      number: r.number || '',
      name: r.name || '',
      elevation: parseFloat(r.elevation) || 0,
    }));
  }

  levels.sort((a, b) => a.elevation - b.elevation);

  const floors = new Map<string, FloorData>();

  const fetchTasks: { disc: string; level: Level; tableName: string }[] = [];
  for (const [disc, tables] of Object.entries(DISCIPLINE_TABLES)) {
    for (const level of levels) {
      for (const tableName of tables) {
        const geoPath = `${level.id}/${tableName}.geojson`;
        const csvPath = `${level.id}/${tableName}.csv`;
        if (manifest && !manifest.has(geoPath) && !manifest.has(csvPath)) continue;
        fetchTasks.push({ disc, level, tableName });
      }
    }
  }

  const results = await Promise.all(
    fetchTasks.map(async ({ disc, level, tableName }) => {
      const [geojsonContent, csvContent] = await Promise.all([
        fetchIfPresent(`${level.id}/${tableName}.geojson`),
        fetchIfPresent(`${level.id}/${tableName}.csv`),
      ]);
      return { disc, level, tableName, geojsonContent, csvContent };
    })
  );

  for (const { disc, level, tableName, geojsonContent, csvContent } of results) {
    if (!geojsonContent && !csvContent) continue;

    const csvMap = new Map<string, CsvRow>();
    if (csvContent) {
      for (const row of parseCsv(csvContent)) {
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
      geojsonContent: isAbsoluteZ
        ? normalizeLevelLayerZ(geojsonContent ?? '', level.elevation, csvMap)
        : (geojsonContent ?? ''),
      csvRows: csvMap,
    });
  }

  // Load element layers from global/ directory (multi-story elements spanning >1 level)
  const globalFetchTasks: { disc: string; tableName: string }[] = [];
  for (const [disc, tables] of Object.entries(DISCIPLINE_TABLES)) {
    for (const tableName of tables) {
      const geoPath = `global/${tableName}.geojson`;
      const csvPath = `global/${tableName}.csv`;
      if (manifest && !manifest.has(geoPath) && !manifest.has(csvPath)) continue;
      globalFetchTasks.push({ disc, tableName });
    }
  }

  const globalResults = await Promise.all(
    globalFetchTasks.map(async ({ disc, tableName }) => {
      const [geojsonContent, csvContent] = await Promise.all([
        fetchIfPresent(`global/${tableName}.geojson`),
        fetchIfPresent(`global/${tableName}.csv`),
      ]);
      return { disc, tableName, geojsonContent, csvContent };
    })
  );

  const globalLayers: LayerData[] = [];
  for (const { disc, tableName, geojsonContent, csvContent } of globalResults) {
    if (!geojsonContent && !csvContent) continue;

    const csvMap = new Map<string, CsvRow>();
    if (csvContent) {
      for (const row of parseCsv(csvContent)) {
        if (row.id) csvMap.set(row.id, row);
      }
    }

    globalLayers.push({
      tableName,
      discipline: disc,
      geojsonContent: geojsonContent ?? '',
      csvRows: csvMap,
    });
  }

  // Project-level MEP system definitions: explicit file rows, plus any
  // system_type found on MEP elements but not declared (e.g. Revit exports with
  // no mep_system.csv) — auto-registered with a palette color so they show in
  // the systems panel and color 2D/3D consistently.
  const declared = await loadMepSystems(ds);
  const derived = deriveMepSystems(declared, floors, globalLayers);
  const mepSystems = [...declared, ...derived];

  return { levels, floors, globalLayers, mepSystems, metadata };
}

/** MEP tables that carry a `system_type` tag. */
const MEP_SYSTEM_TABLES = new Set(['duct', 'pipe', 'conduit', 'cable_tray', 'terminal', 'equipment', 'mep_node']);

/** Distinct, readable palette cycled when auto-assigning colors to systems. */
const SYSTEM_PALETTE = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899',
  '#06b6d4', '#84cc16', '#f97316', '#6366f1', '#14b8a6', '#eab308',
];

function disciplineForSystem(name: string): string {
  const s = name.toLowerCase();
  if (/\bair\b|hvac|chilled|condenser|refriger|exhaust|supply|return/.test(s)) return 'hvac';
  if (/water|sanit|vent|drain|waste|plumb|\bgas\b|domestic/.test(s)) return 'plumbing';
  if (/power|data|cable|electr|low.?volt|fire.?alarm|telecom/.test(s)) return 'electrical';
  return 'other';
}

/** Derive SystemDefs for system_type values present on MEP elements but not
 *  already declared. Equipment carries a comma-joined list of port systems, so
 *  values are split on commas. Deterministic (sorted) so colors are stable. */
function deriveMepSystems(
  existing: SystemDef[],
  floors: Map<string, FloorData>,
  globalLayers: LayerData[],
): SystemDef[] {
  const have = new Set(existing.map(s => s.system_type.trim()).filter(Boolean));
  const seen = new Set<string>();
  const found: string[] = [];
  const scan = (layers: LayerData[]) => {
    for (const layer of layers) {
      if (!MEP_SYSTEM_TABLES.has(layer.tableName)) continue;
      for (const row of layer.csvRows.values()) {
        const raw = (row.system_type || '').trim();
        if (!raw) continue;
        for (const part of raw.split(',')) {
          const v = part.trim();
          if (!v || have.has(v) || seen.has(v)) continue;
          seen.add(v);
          found.push(v);
        }
      }
    }
  };
  for (const f of floors.values()) scan(f.layers);
  scan(globalLayers);
  found.sort();
  return found.map((v, i) => ({
    id: `sys-auto-${i + 1}`,
    system_type: v,
    name: v,
    color: SYSTEM_PALETTE[i % SYSTEM_PALETTE.length],
    discipline: disciplineForSystem(v),
  }));
}

/** Load `global/mep_system.csv` if present. Returns [] when the file is
 *  missing or empty so existing projects keep their auto-coloring behavior. */
export async function loadMepSystems(ds: DataSource): Promise<SystemDef[]> {
  const text = await ds.fetchText('global/mep_system.csv');
  if (!text) return [];
  const rows = parseCsv(text);
  return rows
    .filter(r => r.id || r.system_type)
    .map(r => ({
      id: r.id || '',
      system_type: r.system_type || '',
      name: r.name || '',
      color: r.color || '',
      discipline: r.discipline || '',
    }));
}

export async function loadGrids(ds: DataSource): Promise<GridData[]> {
  const text = await ds.fetchText('global/grid.csv');
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
  return [];
}

export async function loadLayer(ds: DataSource, levelId: string, tableName: string): Promise<LayerData | null> {
  const [geojsonContent, csvContent] = await Promise.all([
    ds.fetchText(`${levelId}/${tableName}.geojson`),
    ds.fetchText(`${levelId}/${tableName}.csv`),
  ]);
  if (!geojsonContent && !csvContent) return null;

  const csvMap = new Map<string, CsvRow>();
  if (csvContent) {
    const rows = parseCsv(csvContent);
    for (const row of rows) {
      if (row.id) csvMap.set(row.id, row);
    }
  }

  return {
    tableName,
    discipline: TABLE_TO_DISCIPLINE[tableName] ?? 'architectural',
    geojsonContent: geojsonContent ?? '',
    csvRows: csvMap,
  };
}
