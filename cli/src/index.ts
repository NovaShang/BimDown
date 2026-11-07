import { Command } from 'commander';
import { resolve } from 'node:path';
import { build } from './build/index.js';
import { buildRegistry, getSpecDir } from './schema/registry.js';
import { discoverLayout, listFiles } from './utils/fs.js';
import { readCsv } from './utils/csv.js';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

declare const CLI_VERSION: string;

const program = new Command();

program
  .name('bimdown')
  .description('BimDown CLI — build, query, and manage BimDown projects')
  .version(typeof CLI_VERSION !== 'undefined' ? CLI_VERSION : '0.0.0');

// ─── build ──────────────────────────────────────────────
const WARN_LIST_LIMIT = 20;

function runBuild(dir: string, opts: { verbose?: boolean } = {}) {
  const absDir = resolve(dir);
  const result = build(absDir);

  if (result.issues.length > 0) {
    for (const issue of result.issues) {
      console.log(issue);
    }
    console.log(`\n${result.issues.length} issue(s) found.`);
    process.exitCode = 1;
  }

  if (result.warnings.length > 0) {
    const shown = opts.verbose ? result.warnings : result.warnings.slice(0, WARN_LIST_LIMIT);
    for (const w of shown) {
      console.log(w);
    }
    if (shown.length < result.warnings.length) {
      console.log(`... ${result.warnings.length - shown.length} more (use --verbose to list all)`);
    }
    console.log(`\n${result.warnings.length} warning(s). Warnings are advisory; issues are errors.`);
  }

  if (result.roomIssues.length > 0) {
    const label = { shared: 'share one enclosed area', contains: 'encloses', unbounded: 'has no enclosing boundary' } as const;
    console.log(`\nRoom problems (${result.roomIssues.length}): derived room areas are wrong until fixed`);
    const shown = opts.verbose ? result.roomIssues : result.roomIssues.slice(0, WARN_LIST_LIMIT);
    for (const r of shown) {
      const text = r.kind === 'contains'
        ? `${r.spaceIds.join(', ')} ${label.contains} ${(r.inside ?? []).join(', ')}`
        : `${r.spaceIds.join(', ')} ${label[r.kind]}`;
      console.log(`  ${r.level}: ${text}`);
    }
    if (shown.length < result.roomIssues.length) {
      console.log(`  ... ${result.roomIssues.length - shown.length} more (use --verbose to list all)`);
    }
  }

  if (result.snaps.length > 0) {
    console.log(`Snapped ${result.snaps.length} endpoint(s) closer than 5 cm:`);
    const shown = opts.verbose ? result.snaps : result.snaps.slice(0, WARN_LIST_LIMIT);
    for (const s of shown) {
      console.log(`  ${s.level}/${s.table} ${s.elementId} ${s.side} (${s.from.x.toFixed(3)}, ${s.from.y.toFixed(3)}) -> (${s.to.x.toFixed(3)}, ${s.to.y.toFixed(3)})`);
    }
    if (shown.length < result.snaps.length) console.log(`  ... ${result.snaps.length - shown.length} more`);
  }

  if (result.artifacts.length > 0) {
    console.log(`\nGenerated: ${result.artifacts.join(', ')}`);
  }

  if (result.issues.length === 0 && result.warnings.length === 0) {
    console.log('Build successful. No issues found.');
  }
}

program
  .command('build')
  .argument('<dir>', 'BimDown project directory')
  .option('--verbose', 'List every warning and snapped endpoint')
  .description('Build a BimDown project (validate + compute space boundaries)')
  .action((dir: string, opts: { verbose?: boolean }) => runBuild(dir, opts));

program
  .command('validate')
  .argument('<dir>', 'BimDown project directory')
  .option('--verbose', 'List every warning and snapped endpoint')
  .description('Alias for build')
  .action((dir: string, opts: { verbose?: boolean }) => runBuild(dir, opts));

// ─── query ──────────────────────────────────────────────
program
  .command('query')
  .argument('<dir>', 'BimDown project directory')
  .argument('<sql>', 'SQL query to execute')
  .option('--json', 'Output results as JSON')
  .description('Hydrate into DuckDB and execute a SQL query')
  .action(async (dir: string, sql: string, opts: { json?: boolean }) => {
    const absDir = resolve(dir);
    const { getConnection, runQuery, closeConnection } = await import('./duckdb/engine.js');
    const { hydrate } = await import('./duckdb/hydrate.js');

    const conn = await getConnection();
    try {
      await hydrate(conn, absDir);
      const result = await runQuery(conn, sql);

      if (opts.json) {
        console.log(JSON.stringify(result.rows, jsonReplacer, 2));
      } else {
        printTable(result.columns, result.rows);
      }
    } finally {
      await closeConnection();
    }
  });

// ─── sync ───────────────────────────────────────────────
program
  .command('sync')
  .argument('<dir>', 'BimDown project directory')
  .description('Hydrate, then dehydrate back (sync DuckDB changes to files)')
  .action(async (dir: string) => {
    const absDir = resolve(dir);
    const { getConnection, closeConnection } = await import('./duckdb/engine.js');
    const { hydrate } = await import('./duckdb/hydrate.js');
    const { dehydrate } = await import('./duckdb/dehydrate.js');

    const conn = await getConnection();
    try {
      const tables = await hydrate(conn, absDir);
      console.log(`Hydrated ${tables.length} tables: ${tables.join(', ')}`);
      await dehydrate(conn, absDir);
      console.log('Sync complete — files updated.');
    } finally {
      await closeConnection();
    }
  });

// ─── render ─────────────────────────────────────────────
program
  .command('render')
  .argument('<dir>', 'BimDown project directory')
  .option('-l, --level <id>', 'Level to render (defaults to lv-1)', 'lv-1')
  .option('-o, --output <file>', 'Output file path (defaults to render.png)', 'render.png')
  .option('-w, --width <px>', 'Image width in pixels', '2048')
  .description('Renders the BimDown project into a visual blueprint (PNG). Color legend: walls=dark navy, structural walls=slate, columns=dark filled, slabs=light grey translucent, spaces=blue translucent, stairs=orange, beams/braces=thin purple dashed centerlines (overhead, drawn under walls), columns at their real section size, foundations=brown dashed outlines (pads width×length, piles as circles, strips at their width, rafts/pile caps), grids=red dash-dot axes with numbered bubbles, slab holes and slab openings (white with a cross), wall openings=orange lines. DOORS render as BOLD RED (#e63946) lines and WINDOWS as BOLD TEAL (#2a9d8f) lines cutting across their host walls. MEP: ducts=cyan, pipes=light blue, cable tray=green, conduit=teal, equipment=red fill, terminals=orange fill.')
  .action(async (dir: string, opts: { level: string; output: string; width: string }) => {
    const absDir = resolve(dir);
    const { renderLevel } = await import('./render.js');
    try {
      const svg = renderLevel(absDir, opts.level);
      if (opts.output.endsWith('.svg')) {
        writeFileSync(opts.output, svg);
      } else {
        const sharp = (await import('sharp')).default;
        const width = parseInt(opts.width, 10) || 2048;
        await sharp(Buffer.from(svg)).resize({ width }).png().toFile(opts.output);
      }
      console.log(`Rendered ${opts.level} to ${opts.output}`);
    } catch (err: any) {
      console.error(`Render failed: ${err.message}`);
      process.exitCode = 1;
    }
  });

// ─── info ───────────────────────────────────────────────
program
  .command('info')
  .argument('<dir>', 'BimDown project directory')
  .description('Print project summary')
  .action((dir: string) => {
    const absDir = resolve(dir);
    const registry = buildRegistry(getSpecDir());
    const layout = discoverLayout(absDir);

    // Levels
    const levelCsv = join(layout.globalDir, 'level.csv');
    if (existsSync(levelCsv)) {
      const levels = readCsv(levelCsv);
      console.log('Levels:');
      for (const row of levels.rows) {
        console.log(`  ${row.id}  ${row.name || row.number || ''}  elevation=${row.elevation}`);
      }
      console.log();
    }

    // Element counts per level
    const allDirs = [
      { name: 'global', path: layout.globalDir },
      ...layout.levelDirs,
    ];

    const totals: Record<string, number> = {};

    for (const d of allDirs) {
      if (!existsSync(d.path)) continue;
      const files = listFiles(d.path);
      const counts: string[] = [];
      for (const f of files) {
        if (!f.endsWith('.csv')) continue;
        const tableName = f.replace('.csv', '');
        if (!registry.has(tableName)) continue;
        const data = readCsv(join(d.path, f));
        counts.push(`${tableName}: ${data.rows.length}`);
        totals[tableName] = (totals[tableName] ?? 0) + data.rows.length;
      }
      if (counts.length > 0) {
        console.log(`${d.name}/  ${counts.join(', ')}`);
      }
    }

    console.log();
    console.log('Totals:');
    let grand = 0;
    for (const [table, count] of Object.entries(totals).sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`  ${table}: ${count}`);
      grand += count;
    }
    console.log(`  TOTAL: ${grand}`);
  });

// ─── resolve-topology ──────────────────────────────────────
program
  .command('resolve-topology')
  .argument('<dir>', 'BimDown project directory')
  .description('Auto-resolve MEP topology: detect coincident endpoints, generate mep_nodes, fill connectivity')
  .action(async (dir: string) => {
    const absDir = resolve(dir);
    const { resolveTopology } = await import('./commands/resolve-topology.js');
    resolveTopology(absDir);
  });

// ─── merge ───────────────────────────────────────────────
program
  .command('merge')
  .argument('<dirs...>', 'Two or more BimDown project directories to merge')
  .requiredOption('-o, --output <dir>', 'Output directory for merged project')
  .description('Merge multiple BimDown project directories into one, resolving ID conflicts')
  .action(async (dirs: string[], opts: { output: string }) => {
    if (dirs.length < 2) {
      console.error('At least 2 source directories are required.');
      process.exitCode = 1;
      return;
    }
    const absDirs = dirs.map((d) => resolve(d));
    const absOut = resolve(opts.output);
    const { merge } = await import('./commands/merge.js');
    await merge(absDirs, absOut);
  });

// ─── schema ─────────────────────────────────────────────
program
  .command('schema')
  .argument('[table]', 'Table name (omit for all tables)')
  .description('Print resolved schema for a table or all tables')
  .action((table?: string) => {
    const registry = buildRegistry(getSpecDir());

    const tables = table ? [table] : [...registry.keys()].sort();
    for (const t of tables) {
      const resolved = registry.get(t);
      if (!resolved) {
        console.error(`Unknown table: ${t}`);
        process.exitCode = 1;
        return;
      }

      console.log(`── ${resolved.name} (prefix: ${resolved.prefix}) ──`);
      if (resolved.hostType) {
        console.log(`  host_type: ${resolved.hostType}`);
      }
      console.log('  CSV fields:');
      for (const f of resolved.csvFields) {
        const tags: string[] = [];
        if (f.required) tags.push('required');
        if (f.type === 'reference') tags.push(`ref:${f.reference}`);
        if (f.type === 'enum') tags.push(`enum:[${f.values?.join('|')}]`);
        const tagStr = tags.length > 0 ? `  (${tags.join(', ')})` : '';
        console.log(`    ${f.name}: ${f.type}${tagStr}`);
      }
      if (resolved.computedFields.length > 0) {
        console.log('  Computed fields:');
        for (const f of resolved.computedFields) {
          console.log(`    ${f.name}: ${f.type}`);
        }
      }
      console.log();
    }
  });

// ─── init ───────────────────────────────────────────────
program
  .command('init')
  .argument('<dir>', 'BimDown project directory')
  .description('Initialize a new BimDown project structure')
  .action(async (dir: string) => {
    const absDir = resolve(dir);
    const { initProject } = await import('./commands/init.js');
    initProject(absDir);
  });

// ─── diff ───────────────────────────────────────────────
program
  .command('diff')
  .argument('<dirA>', 'First BimDown project directory')
  .argument('<dirB>', 'Second BimDown project directory')
  .description('Show differences between two BimDown projects')
  .action(async (dirA: string, dirB: string) => {
    const absA = resolve(dirA);
    const absB = resolve(dirB);
    const { diffProjects } = await import('./commands/diff.js');
    diffProjects(absA, absB);
  });

// ─── publish ───────────────────────────────────────────
program
  .command('publish')
  .argument('<dir>', 'BimDown project directory')
  .option('--expires <duration>', 'Expiration time (e.g. 7d, 24h, 30m)', '7d')
  .option('--api <url>', 'API base URL (default https://bim.jouledown.com, or $BIMDOWN_API)')
  .option('--name <name>', 'Project name')
  .description('Publish a BimDown project to bim.jouledown.com and get a share link')
  .action(async (dir: string, opts: { expires?: string; api?: string; name?: string }) => {
    const { publish } = await import('./commands/publish.js');
    await publish(dir, opts);
  });

program.parse();

// ─── helpers ────────────────────────────────────────────

function printTable(columns: string[], rows: Record<string, unknown>[]) {
  if (rows.length === 0) {
    console.log('(empty result)');
    return;
  }

  // Calculate column widths
  const widths = columns.map((c) => c.length);
  for (const row of rows) {
    for (let i = 0; i < columns.length; i++) {
      const val = formatValue(row[columns[i]]);
      widths[i] = Math.max(widths[i], val.length);
    }
  }

  // Header
  const header = columns.map((c, i) => c.padEnd(widths[i])).join(' | ');
  console.log(header);
  console.log(widths.map((w) => '-'.repeat(w)).join('-+-'));

  // Rows
  for (const row of rows) {
    const line = columns
      .map((c, i) => formatValue(row[c]).padEnd(widths[i]))
      .join(' | ');
    console.log(line);
  }

  console.log(`\n(${rows.length} row(s))`);
}

function formatValue(val: unknown): string {
  if (val == null) return '';
  if (typeof val === 'bigint') return val.toString();
  return String(val);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  return value;
}
