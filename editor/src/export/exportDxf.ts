/**
 * DXF plans: one file per level (a .zip when exporting several), in model
 * coordinates (project units, Y up, `$INSUNITS` set) so each file overlays the
 * model and the other floors exactly — the usual CAD workflow of one plan per
 * floor xref'd on a shared origin. Offsetting floors side by side in one file
 * would break that, and merging them on one origin made them unreadable.
 *
 * Content is the plan drawing (see `drawing/plan.ts`) on AIA-style layers:
 * walls as both faces (A-WALL) with a solid poché hatch (A-WALL-PATT), doors
 * with swing arcs, windows, stairs, room tags, grids with bubbles, structure
 * and MEP (one layer per system, e.g. M-DUCT-SA). Text and linetypes are sized
 * for the chosen plot scale (default 1:100).
 */
import type { ProjectData } from '../types.ts';
import { triggerDownload } from './download.ts';
import { collectPlans, renderPlan, type PlanExportOptions } from './drawing/plan.ts';
import { drawingLang } from './drawing/labels.ts';
import { trueColor, nearestAci } from './drawing/color.ts';
import { needsUnicodeFont } from './drawing/pdfFont.ts';
import { DxfWriter, type DxfEntityStyle } from './drawing/dxfWriter.ts';
import type { LineDash } from './drawing/layers.ts';
import type { PlanDrawing } from './drawing/types.ts';

/** Paper-mm dash patterns (scaled to model units per drawing). */
const LINETYPES: Record<Exclude<LineDash, 'solid'>, { name: string; description: string; mm: number[] }> = {
  dashed: { name: 'DASHED', description: 'Dashed __ __ __', mm: [2.0, -1.0] },
  hidden: { name: 'HIDDEN', description: 'Hidden _ _ _ _', mm: [1.5, -0.8] },
  center: { name: 'CENTER', description: 'Center ____ _ ____', mm: [7, -1.2, 1.2, -1.2] },
};

const linetypeName = (dash: LineDash) => (dash === 'solid' ? 'Continuous' : LINETYPES[dash].name);

/** One level's plan as DXF text. */
export function planToDxf(d: PlanDrawing): string {
  const texts = d.items.flatMap(i => (i.kind === 'text' ? [i.text] : []));
  const dxf = new DxfWriter(d.unit, needsUnicodeFont(texts) ? 'msyh.ttc' : 'arial.ttf');
  for (const lt of Object.values(LINETYPES)) {
    dxf.addLinetype({ name: lt.name, description: lt.description, pattern: lt.mm.map(v => v * d.pm) });
  }
  for (const l of d.layers.values()) {
    dxf.addLayer({
      name: l.name, aci: l.aci, weight: l.weight, linetype: linetypeName(l.dash),
      trueColor: l.trueColor ? trueColor(l.color) : undefined,
    });
  }

  for (const it of d.items) {
    const layer = d.layers.get(it.layer);
    const st: DxfEntityStyle = { layer: it.layer };
    if (it.color && layer && it.color !== layer.color) { st.aci = nearestAci(it.color); st.trueColor = trueColor(it.color); }
    if (it.dash && it.dash !== layer?.dash) st.linetype = linetypeName(it.dash);
    if (it.weight !== undefined && it.weight !== layer?.weight) st.weight = it.weight;
    // Fills: only poché and solid marks (fill = layer ink); white masks and tints are PDF-only
    const solidFill = (fill?: string) => !!fill && !!layer && fill.toLowerCase() === layer.color.toLowerCase();

    switch (it.kind) {
      case 'path':
        if (it.fill && it.closed && solidFill(it.fill)) dxf.solidHatch(it.pts, st);
        if (!it.noStroke) dxf.polyline(it.pts, it.closed, st);
        break;
      case 'circle':
        if (it.fill && solidFill(it.fill)) {
          const n = 24;
          dxf.solidHatch(Array.from({ length: n }, (_, i) => ({
            x: it.center.x + it.radius * Math.cos((i / n) * Math.PI * 2),
            y: it.center.y + it.radius * Math.sin((i / n) * Math.PI * 2),
          })), st);
        }
        if (!it.noStroke) dxf.circle(it.center, it.radius, st);
        break;
      case 'arc':
        dxf.arc(it.center, it.radius, it.start, it.end, st);
        break;
      case 'text':
        dxf.text(it.at, it.text, it.height, st, { align: it.align, valign: it.valign, rotationRad: it.rotation });
        break;
    }
  }
  return dxf.toString();
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'level';

export type DxfExportOptions = PlanExportOptions;

/** DXF files to write: `[file name, content]`. */
export function buildPlanDxfFiles(project: ProjectData, modelName: string, opts: DxfExportOptions = {}): [string, string][] {
  const lang = drawingLang(opts.lang);
  const scale = typeof opts.scale === 'number' && opts.scale > 0 ? opts.scale : 100;
  const files: [string, string][] = [];
  for (const src of collectPlans(project, { ...opts, discipline: opts.discipline ?? 'all' }, lang)) {
    const d = renderPlan(src, scale);
    if (!d.items.length) continue;
    files.push([`${safeName(modelName)}-${safeName(d.levelName)}.dxf`, planToDxf(d)]);
  }
  return files;
}

export async function exportDxf(project: ProjectData, modelName: string, opts: DxfExportOptions = {}): Promise<void> {
  const files = buildPlanDxfFiles(project, modelName, opts);
  if (!files.length) return;
  if (files.length === 1) {
    triggerDownload(new Blob([files[0][1]], { type: 'application/dxf' }), files[0][0]);
    return;
  }
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  for (const [name, content] of files) zip.file(name, content);
  triggerDownload(await zip.generateAsync({ type: 'blob' }), `${safeName(modelName)}-dxf.zip`);
}
