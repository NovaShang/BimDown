/** Cached three.js materials for MEP bodies (ghosted, insulation, flex, devices). */
import { MeshPhysicalMaterial, MeshStandardMaterial } from 'three';

const ghostCache = new Map<string, MeshStandardMaterial>();
/** Isolated-away elements: faint, see-through, no depth write. */
export function ghostMaterial(color: string): MeshStandardMaterial {
  let m = ghostCache.get(color);
  if (!m) {
    m = new MeshStandardMaterial({ color, transparent: true, opacity: 0.1, depthWrite: false });
    ghostCache.set(color, m);
  }
  return m;
}

let insulation: MeshStandardMaterial | null = null;
/** Insulation jacket: translucent off-white shell around the duct / pipe. */
export function insulationMaterial(): MeshStandardMaterial {
  if (!insulation) insulation = new MeshStandardMaterial({ color: '#e8e4da', transparent: true, opacity: 0.35, roughness: 0.9, depthWrite: false });
  return insulation;
}

const flexCache = new Map<string, MeshPhysicalMaterial>();
/** Flex duct: foil-like, lighter than the system colour. */
export function flexMaterial(color: string): MeshPhysicalMaterial {
  let m = flexCache.get(color);
  if (!m) {
    m = new MeshPhysicalMaterial({ color, roughness: 0.3, metalness: 0.6, sheen: 0.5, emissive: color, emissiveIntensity: 0.15 });
    flexCache.set(color, m);
  }
  return m;
}

const solidCache = new Map<string, MeshPhysicalMaterial>();
/** Plain device body in a colour (valves, fixtures). */
export function solidMaterial(color: string, metal = 0.2): MeshPhysicalMaterial {
  const key = `${color}|${metal}`;
  let m = solidCache.get(key);
  if (!m) {
    m = new MeshPhysicalMaterial({ color, roughness: 0.5, metalness: metal });
    solidCache.set(key, m);
  }
  return m;
}
