import { MeshPhysicalMaterial, DoubleSide } from 'three';

export type BimMaterial =
  | 'concrete' | 'concrete_precast' | 'steel' | 'aluminum' | 'glass'
  | 'wood' | 'clt' | 'brick' | 'gypsum' | 'metal_panel' | 'insulation'
  | 'stone' | 'ceramic' | 'copper' | 'pvc' | 'galvanized_steel'
  | 'fiber_cement' | 'composite' | 'default';

export const BIM_MATERIAL_OPTIONS: BimMaterial[] = [
  'concrete', 'concrete_precast', 'steel', 'aluminum', 'glass',
  'wood', 'clt', 'brick', 'gypsum', 'metal_panel', 'insulation',
  'stone', 'ceramic', 'copper', 'pvc', 'galvanized_steel',
  'fiber_cement', 'composite',
];

interface MaterialDef {
  color: string;
  roughness: number;
  metalness: number;
  clearcoat: number;
  opacity: number;
}

const MATERIAL_DEFS: Record<BimMaterial, MaterialDef> = {
  concrete:         { color: '#b0aca8', roughness: 0.92, metalness: 0.0,  clearcoat: 0,    opacity: 1.0  },
  concrete_precast: { color: '#c0bbb5', roughness: 0.85, metalness: 0.0,  clearcoat: 0.02, opacity: 1.0  },
  steel:            { color: '#c0c0c8', roughness: 0.02, metalness: 1.0,  clearcoat: 0,    opacity: 1.0  },
  aluminum:         { color: '#c0c4c8', roughness: 0.25, metalness: 0.85, clearcoat: 0.15, opacity: 1.0  },
  glass:            { color: '#e0f0f8', roughness: 0.0,  metalness: 0.3,  clearcoat: 1.0,  opacity: 0.2  },
  wood:             { color: '#a08060', roughness: 0.82, metalness: 0.0,  clearcoat: 0.03, opacity: 1.0  },
  clt:              { color: '#b89870', roughness: 0.80, metalness: 0.0,  clearcoat: 0.02, opacity: 1.0  },
  brick:            { color: '#9e7057', roughness: 0.92, metalness: 0.0,  clearcoat: 0,    opacity: 1.0  },
  gypsum:           { color: '#e8e4e0', roughness: 0.95, metalness: 0.0,  clearcoat: 0,    opacity: 1.0  },
  metal_panel:      { color: '#a8acb0', roughness: 0.4,  metalness: 0.6,  clearcoat: 0.05, opacity: 1.0  },
  insulation:       { color: '#e8d850', roughness: 0.98, metalness: 0.0,  clearcoat: 0,    opacity: 1.0  },
  stone:            { color: '#c8c0b4', roughness: 0.88, metalness: 0.0,  clearcoat: 0.02, opacity: 1.0  },
  ceramic:          { color: '#e0dcd8', roughness: 0.4,  metalness: 0.0,  clearcoat: 0.3,  opacity: 1.0  },
  copper:           { color: '#b87333', roughness: 0.35, metalness: 0.85, clearcoat: 0.1,  opacity: 1.0  },
  pvc:              { color: '#d8d8d8', roughness: 0.6,  metalness: 0.0,  clearcoat: 0.1,  opacity: 1.0  },
  galvanized_steel: { color: '#a4a8b0', roughness: 0.4,  metalness: 0.7,  clearcoat: 0.08, opacity: 1.0  },
  fiber_cement:     { color: '#c4c0b8', roughness: 0.90, metalness: 0.0,  clearcoat: 0,    opacity: 1.0  },
  composite:        { color: '#b0b4b8', roughness: 0.70, metalness: 0.1,  clearcoat: 0.05, opacity: 1.0  },
  default:          { color: '#b8b8b8', roughness: 0.75, metalness: 0.0,  clearcoat: 0.05, opacity: 1.0  },
};

const TABLE_DEFAULTS: Record<string, BimMaterial> = {
  wall: 'concrete', curtain_wall: 'glass', structure_wall: 'concrete',
  column: 'concrete', structure_column: 'steel',
  door: 'wood', window: 'glass',
  slab: 'concrete', structure_slab: 'concrete', stair: 'concrete',
  beam: 'steel', brace: 'steel',
  duct: 'galvanized_steel', pipe: 'steel',
  conduit: 'pvc', cable_tray: 'galvanized_steel',
  equipment: 'metal_panel', terminal: 'metal_panel',
};

// Ordered from most specific to least specific
const KEYWORD_MAP: [string[], BimMaterial][] = [
  [['glass'],                      'glass'],
  [['precast'],                    'concrete_precast'],
  [['concrete'],                   'concrete'],
  [['aluminum', 'aluminium'],      'aluminum'],
  [['copper'],                     'copper'],
  [['galvanized', 'galvanised'],   'galvanized_steel'],
  [['steel'],                      'steel'],
  [['wood', 'timber'],             'wood'],
  [['brick', 'masonry'],           'brick'],
  [['gypsum', 'drywall', 'stud'], 'gypsum'],
  [['stone', 'granite', 'marble'],'stone'],
  [['ceramic', 'tile', 'porcelain'], 'ceramic'],
  [['pvc', 'plastic'],            'pvc'],
  [['insulation'],                 'insulation'],
  [['fiber_cement', 'fibre_cement', 'fibro'], 'fiber_cement'],
  [['composite'],                  'composite'],
  [['clt', 'cross_laminated'],     'clt'],
  [['metal', 'panel'],            'metal_panel'],
  [['paint'],                      'gypsum'], // painted surfaces → gypsum-like finish
];

/** Resolve a BimMaterial from a CSV material string + tableName fallback. */
export function resolveBimMaterial(materialStr: string | undefined, tableName: string): BimMaterial {
  if (materialStr) {
    const lower = materialStr.toLowerCase();
    for (const [keywords, mat] of KEYWORD_MAP) {
      if (keywords.some(kw => lower.includes(kw))) return mat;
    }
  }
  return TABLE_DEFAULTS[tableName] ?? 'default';
}

// Cached material instances
const materialCache = new Map<string, MeshPhysicalMaterial>();
const ghostCache = new Map<string, MeshPhysicalMaterial>();

/** Get or create a PBR material for the given BimMaterial enum value. */
export function getBimMaterial(bimMat: BimMaterial): MeshPhysicalMaterial {
  const cached = materialCache.get(bimMat);
  if (cached) return cached;

  const def = MATERIAL_DEFS[bimMat];
  const isTransparent = def.opacity < 1;
  const mat = new MeshPhysicalMaterial({
    color: def.color,
    roughness: def.roughness,
    metalness: def.metalness,
    clearcoat: def.clearcoat,
    transparent: isTransparent,
    opacity: def.opacity,
    side: isTransparent ? DoubleSide : undefined,
    envMapIntensity: def.metalness > 0.3 ? 1.0 : 0.5,
    // Glass: clearcoat for reflection + slight metalness to pick up env map
    ...(bimMat === 'glass' && {
      clearcoatRoughness: 0.0,
      reflectivity: 1.0,
      envMapIntensity: 2.0,
      side: DoubleSide,
    }),
  });
  materialCache.set(bimMat, mat);
  return mat;
}

/** Get or create a ghost (semi-transparent) version of a BimMaterial. */
export function getGhostMaterial(bimMat: BimMaterial): MeshPhysicalMaterial {
  const cached = ghostCache.get(bimMat);
  if (cached) return cached;

  const def = MATERIAL_DEFS[bimMat];
  const mat = new MeshPhysicalMaterial({
    color: def.color,
    roughness: 0.85,
    metalness: 0.0,
    transparent: true,
    opacity: 0.15,
    side: DoubleSide,
    depthWrite: false,
  });
  ghostCache.set(bimMat, mat);
  return mat;
}
