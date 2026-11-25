/** Library search: every query token must appear in a family's names / keywords. */
import { CATEGORY_LABELS, furnitureFamilies, type FurnitureCategory, type FurnitureFamily } from './furnitureLibrary.ts';

/** Lower-case haystack for search: ids, both languages, keywords, variants, category. */
function haystack(f: FurnitureFamily): string {
  const c = CATEGORY_LABELS[f.category];
  return [f.id.replace(/_/g, ' '), f.en, f.zh, f.keywords, c.en, c.zh, ...(f.variants ?? []).flatMap(v => [v.en, v.zh])]
    .join(' ').toLowerCase();
}

export function filterFamilies(query: string, category: FurnitureCategory | 'all'): FurnitureFamily[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return furnitureFamilies().filter(f =>
    (category === 'all' || f.category === category)
    && tokens.every(t => haystack(f).includes(t)));
}

