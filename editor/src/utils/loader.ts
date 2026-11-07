import type { CsvRow, Level, FloorData, ProjectData, GridData, LayerData, ProjectMetadata, ProjectUnit, SystemDef } from '../types.ts';
import { DISCIPLINE_TABLES, TABLE_TO_DISCIPLINE } from '../types.ts';
import type { DataSource } from './dataSource.ts';
import { sectionsFromRows, VIEW_CSV_PATH } from '../views/sectionsIO.ts';
import type { SectionDef } from '../views/viewTypes.ts';

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
      spatial_z: json.spatial_z,
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

/** Spatial tables: geometry carries absolute Z in its coordinates (spec §4.2). */
const SPATIAL_TABLES = new Set([
  'stair', 'ramp', 'railing', 'beam', 'brace',
  'duct', 'pipe', 'cable_tray', 'conduit',
  'equipment', 'terminal', 'mep_node',
]);

/** Z offsets the spec stores in GeoJSON `properties` (the editor reads them as attrs). */
const GEOJSON_Z_PROPS = ['base_offset', 'top_offset', 'height_offset'] as const;

/**
 * Bring one layer from the on-disk spec form into the editor model.
 *
 * - Spatial coordinates carry **absolute** Z (spec §4.2) for every project; the
 *   editor model is **level-relative** (`levelElevation + z`, draw defaults like
 *   `start_z: '3'` mean "3 m above the floor"), so subtract the level elevation:
 *     - LineString coords (beam/duct/…): `z -= elevation` (read as startZ/endZ).
 *     - 3D Point coords (equipment/terminal/mep_node): the relative Z becomes the
 *       row's `base_offset` (what `buildPoint` reads).
 *   `persistDocument` adds the elevation back on save (see serializeToGeoJson).
 * - `base_offset` / `top_offset` / `height_offset` written in GeoJSON properties
 *   (spec storage) are copied into the row; they win over a stale CSV column.
 *
 * Global layers use elevation 0, so only the property hoisting applies there.
 */
export function importLayerGeometry(
  geojsonContent: string,
  elevation: number,
  csvMap: Map<string, CsvRow>,
  tableName: string,
): string {
  if (!geojsonContent) return geojsonContent;
  let fc: { features?: { geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, unknown> }[] };
  try { fc = JSON.parse(geojsonContent); } catch { return geojsonContent; }
  if (!Array.isArray(fc.features)) return geojsonContent;
  const spatial = SPATIAL_TABLES.has(tableName);
  for (const ft of fc.features) {
    const id = typeof ft.properties?.id === 'string' ? ft.properties.id : undefined;
    const row: CsvRow | undefined = id ? (csvMap.get(id) ?? { id }) : undefined;
    for (const key of GEOJSON_Z_PROPS) {
      const v = ft.properties?.[key];
      if (row && typeof v === 'number' && isFinite(v)) row[key] = String(v);
    }
    const g = ft.geometry;
    if (spatial && g?.type === 'Point') {
      const c = g.coordinates as number[];
      if (Array.isArray(c) && c.length >= 3 && typeof c[2] === 'number') {
        c[2] = c[2] - elevation;
        if (row) row.base_offset = String(c[2]);
      }
    } else if (spatial && g?.type === 'LineString') {
      const coords = g.coordinates as number[][];
      if (Array.isArray(coords)) {
        for (const c of coords) {
          if (Array.isArray(c) && c.length >= 3 && typeof c[2] === 'number') c[2] = c[2] - elevation;
        }
      }
    }
    if (row && id && !csvMap.has(id)) csvMap.set(id, row);
  }
  return JSON.stringify(fc);
}

/** True when a level layer (elevation ≠ 0) holds spatial geometry with a Z. In
 *  a project without the `spatial_z` marker such Z may be legacy level-relative
 *  (pre-marker editor saves), so the editor must not stamp the marker on it. */
function hasElevatedSpatialZ(geojsonContent: string, elevation: number, tableName: string): boolean {
  if (elevation === 0 || !SPATIAL_TABLES.has(tableName) || !geojsonContent) return false;
  return /\[\s*-?[\d.eE+-]+\s*,\s*-?[\d.eE+-]+\s*,\s*-?[\d.eE+-]+\s*\]/.test(geojsonContent);
}

/** In-flight `listFiles()` per data source: a project load and the grid load
 *  that runs beside it share one listing. Cleared once settled, so a later
 *  load (e.g. after a file change) lists afresh. */
const pendingManifests = new WeakMap<DataSource, Promise<Set<string> | null>>();

function listManifest(ds: DataSource): Promise<Set<string> | null> {
  if (!ds.listFiles) return Promise.resolve(null);
  let pending = pendingManifests.get(ds);
  if (!pending) {
    pending = ds.listFiles().then(files => new Set(files));
    pendingManifests.set(ds, pending);
    const clear = () => { if (pendingManifests.get(ds) === pending) pendingManifests.delete(ds); };
    pending.then(clear, clear);
  }
  return pending;
}

/** Fetch `path` unless the manifest says it isn't there (no 404 for optional files). */
function fetchListed(ds: DataSource, manifest: Set<string> | null, path: string): Promise<string | null> {
  return manifest && !manifest.has(path) ? Promise.resolve(null) : ds.fetchText(path);
}

export async function loadProject(ds: DataSource): Promise<ProjectData> {
  const metadataPromise = loadProjectMetadata(ds);
  const manifest = await listManifest(ds);
  const fetchIfPresent = (p: string) => fetchListed(ds, manifest, p);

  const metadata = await metadataPromise;
  let elevatedSpatialZ = false;

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

    if (hasElevatedSpatialZ(geojsonContent ?? '', level.elevation, tableName)) elevatedSpatialZ = true;
    floors.get(level.id)!.layers.push({
      tableName,
      discipline: disc,
      geojsonContent: importLayerGeometry(geojsonContent ?? '', level.elevation, csvMap, tableName),
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
      geojsonContent: importLayerGeometry(geojsonContent ?? '', 0, csvMap, tableName),
      csvRows: csvMap,
    });
  }

  // Project-level MEP system definitions: explicit file rows, plus any
  // system_type found on MEP elements but not declared (e.g. Revit exports with
  // no mep_system.csv) — auto-registered with a palette color so they show in
  // the systems panel and color 2D/3D consistently.
  const declared = parseMepSystems(await fetchIfPresent('global/mep_system.csv'));
  const viewText = await fetchIfPresent(VIEW_CSV_PATH);
  const sections = viewText ? sectionsFromRows(parseCsv(viewText)) : [];
  const derived = deriveMepSystems(declared, floors, globalLayers);
  const mepSystems = [...declared, ...derived];

  // Safe to stamp `spatial_z: absolute` on save unless the project is unmarked
  // and holds elevated spatial Z that might be legacy level-relative.
  const spatialZMarkable = metadata.spatial_z !== 'absolute' && !elevatedSpatialZ;
  return { levels, floors, globalLayers, mepSystems, metadata, spatialZMarkable, sections };
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
  return parseMepSystems(await ds.fetchText('global/mep_system.csv'));
}

function parseMepSystems(text: string | null): SystemDef[] {
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

/** Load the saved section views from `global/view.csv` ([] when absent). */
export async function loadSections(ds: DataSource): Promise<SectionDef[]> {
  const text = await ds.fetchText(VIEW_CSV_PATH);
  return text ? sectionsFromRows(parseCsv(text)) : [];
}

export async function loadGrids(ds: DataSource): Promise<GridData[]> {
  const text = await fetchListed(ds, await listManifest(ds), 'global/grid.csv');
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

/**
 * Reload one layer (e.g. after an external file change). `elevation` is the
 * level's elevation; when omitted it is looked up in global/level.csv.
 */
export async function loadLayer(
  ds: DataSource, levelId: string, tableName: string, elevation?: number,
): Promise<LayerData | null> {
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

  let elev = elevation;
  if (elev === undefined) {
    elev = 0;
    if (levelId !== 'global') {
      const levelText = await ds.fetchText('global/level.csv');
      const row = levelText ? parseCsv(levelText).find(r => r.id === levelId) : undefined;
      elev = row ? parseFloat(row.elevation) || 0 : 0;
    }
  }

  return {
    tableName,
    discipline: TABLE_TO_DISCIPLINE[tableName] ?? 'architectural',
    geojsonContent: importLayerGeometry(geojsonContent ?? '', elev, csvMap, tableName),
    csvRows: csvMap,
  };
}
