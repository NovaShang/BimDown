import { checkMep, type MepProblem } from './check.js';
import { loadMep, summarizeSystems, type SystemSummary } from './load.js';

export { checkMep, loadMep, summarizeSystems };
export type { MepProblem, SystemSummary };

export interface MepReport {
  systems: SystemSummary[];
  problems: (MepProblem & { dir: string })[];
}

export function mepReport(dir: string): MepReport {
  const m = loadMep(dir);
  const problems = checkMep(m).map(p => ({ ...p, dir: p.scope ?? '' }));
  return { systems: summarizeSystems(m), problems };
}

/** One line per problem: `lv-1/duct.csv  du-3: …`. */
export function formatProblem(p: MepProblem & { dir: string }): string {
  return `${p.dir ? `${p.dir}/` : ''}${p.table}.csv  ${p.id}: [${p.code}] ${p.message}`;
}

/** Connectivity warnings for `bimdown build` (info-level findings are left out). */
export function mepWarnings(dir: string): string[] {
  const r = mepReport(dir);
  return r.problems.filter(p => p.severity === 'warning').map(formatProblem);
}
