/**
 * Block SVG loader.
 * Loads all SVG files from assets/blocks/ as raw strings via import.meta.glob.
 * Block SVGs use unit coordinates (0-1) and are scaled/transformed by renderers.
 */

const svgModules = import.meta.glob('../assets/blocks/*.svg', { eager: true, query: '?raw', import: 'default' });

const blockMap: Record<string, string> = {};
for (const path in svgModules) {
  const name = path.match(/\/([^/]+)\.svg$/)?.[1];
  if (name) blockMap[name] = svgModules[path] as string;
}

/** Get raw SVG inner content (strip the outer <svg> tag) for embedding. */
export function getBlockSvg(name: string): string | null {
  const raw = blockMap[name];
  if (!raw) return null;
  // Extract content between <svg ...> and </svg>
  const match = raw.match(/<svg[^>]*>([\s\S]*?)<\/svg>/);
  return match?.[1]?.trim() ?? null;
}

/** List all available block names. */
export function getBlockNames(): string[] {
  return Object.keys(blockMap);
}
