/** IfcGrid axes → grid rows; furniture → furniture boxes (when the format has the table). */
import { numberOf } from './names.js';
import type { ImportContext, OutEl } from './context.js';
import { curve } from './representation.js';
import { str } from './model.js';
import { planObb } from './geometry.js';
import { angleDeg, r3 } from './math.js';

export function convertGrid(ctx: ImportContext, id: number): number {
  const { model } = ctx;
  const g = model.line(id);
  const m = model.productMatrix(id);
  if (!g || !m) { ctx.skip(id, 'no placement'); return 0; }
  let n = 0;
  const used = new Set<string>();
  for (const axes of [g.UAxes, g.VAxes, g.WAxes]) {
    for (const ax of model.refs(axes)) {
      const c = curve(model, model.ref(ax.AxisCurve), m);
      if (!c || c.points.length < 2) continue;
      const a = c.points[0], b = c.points[c.points.length - 1];
      if (Math.hypot(b.x - a.x, b.y - a.y) < 0.01) continue;
      let tag = str(ax.AxisTag) ?? String(ctx.out.filter(e => e.table === 'grid').length + 1);
      while (used.has(tag)) tag = `${tag}'`;
      used.add(tag);
      const el = ctx.add('grid', id, 0, { number: tag, start_x: r3(a.x), start_y: r3(a.y), end_x: r3(b.x), end_y: r3(b.y) }, null);
      el.global = true;
      n++;
    }
  }
  if (n === 0) ctx.skip(id, 'no axes');
  return n;
}

const FAMILIES: [RegExp, string][] = [
  [/office.?chair|bürostuhl|drehstuhl|task.?chair/, 'office_chair'],
  [/arm.?chair|sessel/, 'armchair'],
  [/sofa|couch/, 'sofa'],
  [/chair|stuhl|seat|hocker|stool/, 'chair'],
  [/meeting|conference|besprechung|konferenz/, 'meeting_table'],
  [/dining|esstisch/, 'dining_table'],
  [/coffee|couchtisch|side.?table|beistell/, 'coffee_table'],
  [/desk|schreibtisch|workstation|arbeitsplatz/, 'desk'],
  [/table|tisch/, 'dining_table'],
  [/night.?stand|nachttisch/, 'nightstand'],
  [/bed\b|bett/, 'bed'],
  [/wardrobe|kleiderschrank|closet/, 'wardrobe'],
  [/book|regal|shelf|shelv/, 'bookshelf'],
  [/file|akten|cabinet.*file/, 'filing_cabinet'],
  [/sideboard|credenza|kommode|dresser/, 'sideboard'],
  [/reception|empfang|counter|theke/, 'reception_counter'],
  [/locker|spind/, 'locker'],
  [/wall.?cabinet|hängeschrank|oberschrank|upper.?cabinet/, 'wall_cabinet'],
  [/tall.?cabinet|hochschrank|pantry/, 'tall_cabinet'],
  [/base.?cabinet|unterschrank|kitchen|küche|casework|counter/, 'base_cabinet'],
  [/fridge|refrigerator|kühlschrank/, 'refrigerator'],
  [/stove|range|herd|oven|cooktop/, 'stove'],
  [/dishwasher|spülmaschine|geschirrspül/, 'dishwasher'],
  [/washing|washer|waschmaschine|dryer|trockner/, 'washing_machine'],
  [/partition|trennwand.*wc|toilet.?cubicle/, 'toilet_partition'],
  [/\bcar\b|auto|vehicle|fahrzeug/, 'car'],
  [/tree|baum/, 'tree'],
  [/plant|pflanze/, 'plant'],
  [/person|people|mensch|figure/, 'person'],
];

export function furnitureFamily(name: string): string {
  const n = name.toLowerCase();
  for (const [re, f] of FAMILIES) if (re.test(n)) return f;
  return 'generic_box';
}

/** Furnishing element → furniture point with its box size (local +Y = back). */
export function convertFurniture(ctx: ImportContext, id: number): OutEl | null {
  const mesh = ctx.mesh(id);
  if (!mesh) { ctx.skip(id, 'no body geometry'); return null; }
  const obb = planObb(mesh);
  if (!obb) { ctx.skip(id, 'no usable geometry'); return null; }
  const level = ctx.levelOf(id, mesh.min.z);
  const label = ctx.label(id) ?? '';
  const props: Record<string, unknown> = {};
  const rot = angleDeg(obb.u);
  if (Math.abs(rot) >= 0.05) props.rotation = Math.round(rot * 100) / 100;
  const base = mesh.min.z - ctx.elevation(level);
  if (Math.abs(base) >= 0.0005) props.base_offset = r3(base);
  return ctx.add('furniture', id, level, {
    number: numberOf(ctx, id), family: furnitureFamily(`${label} ${str(ctx.model.line(id)?.ObjectType) ?? ''}`),
    size_x: r3(obb.length), size_y: r3(obb.width), height: r3(mesh.max.z - mesh.min.z),
  }, { type: 'Point', coordinates: [r3(obb.center.x), r3(obb.center.y)] }, props);
}
