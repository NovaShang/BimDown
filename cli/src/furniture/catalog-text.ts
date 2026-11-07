/** Text listing of the furniture library, appended to `bimdown schema furniture`. */
import { CATEGORY_LABELS, CATEGORY_ORDER, furnitureFamilies } from './library.js';

const size = (s: [number, number, number]) => s.map(v => +v.toFixed(3)).join('×');

export function furnitureCatalogLines(): string[] {
  const lines = ['  Families (default size_x×size_y×height m; variants with their own default size):'];
  for (const cat of CATEGORY_ORDER) {
    const fams = furnitureFamilies().filter(f => f.category === cat);
    if (fams.length === 0) continue;
    lines.push(`   ${CATEGORY_LABELS[cat].en}:`);
    for (const f of fams) {
      const tags: string[] = [];
      if (f.wallBacked) tags.push('back to wall');
      if (f.baseOffset) tags.push(`base_offset ${f.baseOffset}`);
      const variants = (f.variants ?? []).map((v, i) => `${v.id}${v.size ? ` ${size(v.size)}` : ''}${i === 0 ? ' (default)' : ''}`);
      lines.push(`    ${f.id}  ${size(f.size)}${tags.length ? `  [${tags.join(', ')}]` : ''}${variants.length ? `  variants: ${variants.join(', ')}` : ''}`);
    }
  }
  return lines;
}
