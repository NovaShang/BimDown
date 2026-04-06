import type {
  BimPrimitive, CompositePrimitive,
  PathPrimitive, InstancePrimitive,
  CurtainWallRule, StairRule, RailingRule, Vec3,
} from '../primitives/types.ts';

/**
 * Expand a CompositePrimitive into base primitives (Surface/Path/Instance).
 * Returns an empty array if the rule type is not supported.
 */
export function expandComposite(c: CompositePrimitive): BimPrimitive[] {
  switch (c.rule.type) {
    case 'curtain_wall': return expandCurtainWall(c.rule, c.elementId);
    case 'stair':        return expandStair(c.rule, c.elementId);
    case 'railing':      return expandRailing(c.rule, c.elementId);
  }
}

/**
 * Curtain wall: vertical + horizontal mullions as PathPrimitives, glass panels as thin
 * InstancePrimitive(box) instances. All built in wall-local space then placed in world.
 */
function expandCurtainWall(r: CurtainWallRule, elementId: string): BimPrimitive[] {
  const dx = r.end.x - r.start.x;
  const dy = r.end.y - r.start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.001) return [];

  const angle = Math.atan2(dy, dx);
  const ux = dx / len;
  const uy = dy / len;
  // perpendicular in wall plane (horizontal, points toward wall +normal): (-uy, ux)
  // We keep mullions/panels on the wall centerline (z=0 local).

  const cellW = len / r.uGridCount;
  const cellH = r.height / r.vGridCount;

  const result: BimPrimitive[] = [];

  // Vertical mullions at each u-grid line (including both ends)
  for (let i = 0; i <= r.uGridCount; i++) {
    const lx = i * cellW; // distance from start along wall
    const worldX = r.start.x + ux * lx;
    const worldSvgY = r.start.y + uy * lx;
    // Vertical mullion is a vertical line from baseY to baseY+height at (worldX, 0, -worldSvgY)
    const path: [Vec3, Vec3] = [
      { x: worldX, y: r.baseY, z: -worldSvgY },
      { x: worldX, y: r.baseY + r.height, z: -worldSvgY },
    ];
    result.push({
      kind: 'path',
      id: `path:${elementId}:vmull:${i}`,
      elementId,
      tableName: 'curtain_wall',
      profile: { kind: 'rect', width: r.mullionSize, depth: r.mullionSize },
      path,
      material: r.frameMaterial,
    } as PathPrimitive);
  }

  // Horizontal mullions (transoms) at each v-grid line
  for (let j = 0; j <= r.vGridCount; j++) {
    const ly = j * cellH;
    const y = r.baseY + ly;
    const path: [Vec3, Vec3] = [
      { x: r.start.x, y, z: -r.start.y },
      { x: r.end.x,   y, z: -r.end.y },
    ];
    result.push({
      kind: 'path',
      id: `path:${elementId}:hmull:${j}`,
      elementId,
      tableName: 'curtain_wall',
      profile: { kind: 'rect', width: r.mullionSize, depth: r.mullionSize },
      path,
      material: r.frameMaterial,
    } as PathPrimitive);
  }

  // Glass panels: thin InstancePrimitive(box) in each cell
  for (let i = 0; i < r.uGridCount; i++) {
    for (let j = 0; j < r.vGridCount; j++) {
      const pw = cellW - r.mullionSize;
      const ph = cellH - r.mullionSize;
      if (pw <= 0.01 || ph <= 0.01) continue;

      const lx = (i + 0.5) * cellW;
      const ly = (j + 0.5) * cellH;
      const panelCx = r.start.x + ux * lx;
      const panelCySvg = r.start.y + uy * lx;
      const panelCy = r.baseY + ly;

      result.push({
        kind: 'instance',
        id: `instance:${elementId}:panel:${i}:${j}`,
        elementId,
        tableName: 'curtain_wall',
        position: { x: panelCx, y: panelCy, z: -panelCySvg },
        rotation: { x: 0, y: angle, z: 0 },
        scale: { x: pw, y: ph, z: r.panelThickness },
        source: { type: 'box' },
        material: r.panelMaterial,
      } as InstancePrimitive);
    }
  }

  return result;
}

/**
 * Stair: array of tread InstancePrimitives distributed along slope direction.
 * Each tread is a thin horizontal box.
 */
function expandStair(r: StairRule, elementId: string): BimPrimitive[] {
  const dx = r.end.x - r.start.x;
  const dy = r.end.y - r.start.y;
  const horLen = Math.sqrt(dx * dx + dy * dy);
  if (horLen < 0.001) return [];

  const dz = r.endZ - r.startZ;
  const angle = Math.atan2(dy, dx);
  const treadDepth = horLen / r.stepCount;
  const treadThickness = 0.03;
  const rise = dz / r.stepCount;

  const ux = dx / horLen;
  const uy = dy / horLen;

  const result: BimPrimitive[] = [];
  for (let i = 0; i < r.stepCount; i++) {
    // Tread occupies [i*treadDepth, (i+1)*treadDepth] along path; top-of-tread at startZ + (i+1)*rise
    const cxAlong = (i + 0.5) * treadDepth;
    const worldX = r.start.x + ux * cxAlong;
    const worldSvgY = r.start.y + uy * cxAlong;
    const topZ = r.startZ + (i + 1) * rise;
    const treadCenterY = topZ - treadThickness / 2;

    result.push({
      kind: 'instance',
      id: `instance:${elementId}:tread:${i}`,
      elementId,
      tableName: 'stair',
      position: { x: worldX, y: treadCenterY, z: -worldSvgY },
      rotation: { x: 0, y: angle, z: 0 },
      scale: { x: treadDepth, y: treadThickness, z: r.width },
      source: { type: 'box' },
      material: r.material,
    } as InstancePrimitive);
  }

  return result;
}

/**
 * Railing: top handrail PathPrimitive + array of baluster InstancePrimitives along path.
 */
function expandRailing(r: RailingRule, elementId: string): BimPrimitive[] {
  const result: BimPrimitive[] = [];
  if (r.path.length < 2) return result;

  const a = r.path[0];
  const b = r.path[1];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const horLen = Math.sqrt(dx * dx + dz * dz);
  if (horLen < 0.001) return result;

  const ux = dx / horLen;
  const uz = dz / horLen;
  const angle = Math.atan2(-dz, dx);

  // Top handrail as PathPrimitive at railing top
  const topY_a = a.y + r.height;
  const topY_b = b.y + r.height;
  result.push({
    kind: 'path',
    id: `path:${elementId}:handrail`,
    elementId,
    tableName: 'railing',
    profile: r.handrailProfile,
    path: [
      { x: a.x, y: topY_a, z: a.z },
      { x: b.x, y: topY_b, z: b.z },
    ],
    material: r.material,
  } as PathPrimitive);

  // Balusters at even spacing
  const balusterCount = Math.max(2, Math.floor(horLen / r.balusterSpacing) + 1);
  const step = horLen / (balusterCount - 1);
  const prof = r.balusterProfile;
  const balusterSize = prof.kind === 'rect' ? Math.max(prof.width, prof.depth) : 0.025;

  for (let i = 0; i < balusterCount; i++) {
    const t = i * step;
    const bx = a.x + ux * t;
    const bz = a.z + uz * t;
    // Interpolate y from path start to end
    const lerp = balusterCount === 1 ? 0 : t / horLen;
    const by = a.y + (b.y - a.y) * lerp;
    const centerY = by + r.height / 2;
    result.push({
      kind: 'instance',
      id: `instance:${elementId}:bal:${i}`,
      elementId,
      tableName: 'railing',
      position: { x: bx, y: centerY, z: bz },
      rotation: { x: 0, y: angle, z: 0 },
      scale: { x: balusterSize, y: r.height, z: balusterSize },
      source: { type: 'box' },
      material: r.material,
    } as InstancePrimitive);
  }

  return result;
}

/**
 * Expand all composite primitives in a list, keeping non-composite primitives as-is.
 */
export function expandComposites(prims: BimPrimitive[]): BimPrimitive[] {
  const result: BimPrimitive[] = [];
  for (const p of prims) {
    if (p.kind === 'composite') {
      result.push(...expandComposite(p));
    } else {
      result.push(p);
    }
  }
  return result;
}
