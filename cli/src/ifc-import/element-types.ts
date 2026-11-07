/** Layered element types (wall_type / slab_type / roof_type + type_layer) from IFC material layer sets. */
import type { ImportContext } from './context.js';
import type { LayerSetInfo } from './materials.js';
import { r3 } from './math.js';

export type LayeredTable = 'wall_type' | 'slab_type' | 'roof_type';

const PREFIX: Record<LayeredTable, string> = { wall_type: 'wt', slab_type: 'slt', roof_type: 'rot' };

export class TypeCatalog {
  private ids = new Map<string, string>();
  private used = new Set<string>();

  constructor(private ctx: ImportContext) {}

  /**
   * Type id for a layer set, created on first use. `inOrder`: the IFC layer
   * order already is BimDown's (seq 1 = wall exterior / slab top); else the
   * layers are reversed.
   */
  ensure(table: LayeredTable, ls: LayerSetInfo, name: string | undefined, inOrder: boolean): string {
    const key = `${table}:${ls.setId}:${inOrder ? 1 : 0}`;
    const existing = this.ids.get(key);
    if (existing) return existing;
    const label = (ls.name ?? name ?? `${ls.layers.length} layers ${Math.round(ls.total * 1000)} mm`).slice(0, 120);
    const id = this.uniqueId(`${PREFIX[table]}-${slug(label) || 'type'}`);
    const core = ls.layers.find(l => l.function === 'core') ?? ls.layers[0];
    const el = this.ctx.add(table, 0, 0, { name: label, material: core.material, thickness: undefined }, null);
    el.id = id;
    el.global = true;
    const layers = inOrder ? ls.layers : ls.layers.slice().reverse();
    layers.forEach((l, i) => {
      const row = this.ctx.add('type_layer', 0, 0, {
        type_id: id, seq: i + 1, function: l.function, material: l.material, thickness: r3(l.thickness), name: l.name ?? undefined,
      }, null);
      row.global = true;
    });
    this.ids.set(key, id);
    return id;
  }

  private uniqueId(base: string): string {
    let id = base, n = 2;
    while (this.used.has(id)) id = `${base}-${n++}`;
    this.used.add(id);
    return id;
  }
}

function slug(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}
