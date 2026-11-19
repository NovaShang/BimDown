/**
 * Plan hatches for type layers (fine detail): one SVG pattern per material
 * class, defined once in the canvas (<LayerHatchDefs/>) and referenced by
 * layered walls. Patterns are in model units (metres).
 */

type HatchKey = 'concrete' | 'masonry' | 'insulation' | 'wood' | 'gypsum' | 'metal' | 'glass' | 'membrane' | 'air' | 'generic';

const BASE: Record<HatchKey, string> = {
  concrete: '#dcdcdc',
  masonry: '#efd3c2',
  insulation: '#fbf3d0',
  wood: '#ecd6b3',
  gypsum: '#f5f2ec',
  metal: '#d9dee4',
  glass: '#dbeafe',
  membrane: '#5b6472',
  air: '#ffffff',
  generic: '#e7e5e4',
};

export function hatchKey(layer: { material: string; function: string }): HatchKey {
  if (layer.function === 'air_gap') return 'air';
  if (layer.function === 'membrane') return 'membrane';
  const m = (layer.material || '').toLowerCase();
  if (layer.function === 'insulation' || m === 'insulation') return 'insulation';
  if (m === 'concrete') return 'concrete';
  if (m === 'brick' || m === 'stone' || m === 'ceramic') return 'masonry';
  if (m === 'wood' || m === 'clt') return 'wood';
  if (m === 'gypsum') return 'gypsum';
  if (m === 'steel' || m === 'aluminum' || m === 'copper') return 'metal';
  if (m === 'glass') return 'glass';
  return 'generic';
}

/** SVG fill for a layer: its hatch pattern, falling back to the base colour. */
export function layerFill(layer: { material: string; function: string }): string {
  const k = hatchKey(layer);
  return `url(#bd-lh-${k}) ${BASE[k]}`;
}

/** Plain colour of a layer (swatches in the Edit Type dialog). */
export function layerColor(layer: { material: string; function: string }): string {
  return BASE[hatchKey(layer)];
}

const S = 0.006; // hatch stroke width, m

export function LayerHatchDefs() {
  return (
    <defs>
      <pattern id="bd-lh-concrete" patternUnits="userSpaceOnUse" width="0.12" height="0.12">
        <rect width="0.12" height="0.12" fill={BASE.concrete} />
        <circle cx="0.02" cy="0.03" r="0.006" fill="#8c8c8c" />
        <circle cx="0.08" cy="0.02" r="0.004" fill="#8c8c8c" />
        <circle cx="0.06" cy="0.08" r="0.007" fill="#8c8c8c" />
        <circle cx="0.105" cy="0.1" r="0.004" fill="#8c8c8c" />
        <path d="M0.02,0.1 l0.012,-0.02 l0.012,0.02 z" fill="none" stroke="#8c8c8c" strokeWidth={S / 2} />
      </pattern>
      <pattern id="bd-lh-masonry" patternUnits="userSpaceOnUse" width="0.06" height="0.06" patternTransform="rotate(45)">
        <rect width="0.06" height="0.06" fill={BASE.masonry} />
        <line x1="0" y1="0" x2="0" y2="0.06" stroke="#b5643c" strokeWidth={S} />
      </pattern>
      <pattern id="bd-lh-wood" patternUnits="userSpaceOnUse" width="0.05" height="0.05" patternTransform="rotate(-45)">
        <rect width="0.05" height="0.05" fill={BASE.wood} />
        <line x1="0" y1="0" x2="0" y2="0.05" stroke="#a87437" strokeWidth={S / 1.5} />
      </pattern>
      <pattern id="bd-lh-insulation" patternUnits="userSpaceOnUse" width="0.08" height="0.08">
        <rect width="0.08" height="0.08" fill={BASE.insulation} />
        <path d="M0,0.04 Q0.02,0 0.04,0.04 T0.08,0.04" fill="none" stroke="#c39a1d" strokeWidth={S} />
      </pattern>
      <pattern id="bd-lh-gypsum" patternUnits="userSpaceOnUse" width="0.05" height="0.05">
        <rect width="0.05" height="0.05" fill={BASE.gypsum} />
        <circle cx="0.025" cy="0.025" r="0.003" fill="#c9c2b6" />
      </pattern>
      <pattern id="bd-lh-metal" patternUnits="userSpaceOnUse" width="0.04" height="0.04" patternTransform="rotate(45)">
        <rect width="0.04" height="0.04" fill={BASE.metal} />
        <line x1="0" y1="0" x2="0" y2="0.04" stroke="#7b8794" strokeWidth={S / 1.5} />
        <line x1="0" y1="0" x2="0.04" y2="0" stroke="#7b8794" strokeWidth={S / 1.5} />
      </pattern>
      <pattern id="bd-lh-glass" patternUnits="userSpaceOnUse" width="0.1" height="0.1">
        <rect width="0.1" height="0.1" fill={BASE.glass} />
      </pattern>
      <pattern id="bd-lh-membrane" patternUnits="userSpaceOnUse" width="0.1" height="0.1">
        <rect width="0.1" height="0.1" fill={BASE.membrane} />
      </pattern>
      <pattern id="bd-lh-air" patternUnits="userSpaceOnUse" width="0.1" height="0.1">
        <rect width="0.1" height="0.1" fill={BASE.air} />
      </pattern>
      <pattern id="bd-lh-generic" patternUnits="userSpaceOnUse" width="0.06" height="0.06" patternTransform="rotate(45)">
        <rect width="0.06" height="0.06" fill={BASE.generic} />
        <line x1="0" y1="0" x2="0" y2="0.06" stroke="#a8a29e" strokeWidth={S / 2} strokeDasharray="0.01 0.01" />
      </pattern>
    </defs>
  );
}
