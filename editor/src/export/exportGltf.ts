import type { ProjectData } from '../types.ts';
import { parseFloorLayers } from '../model/parse.ts';
import { elementTo3DParams } from '../three/utils/elementTo3D.ts';
import type { BoxParams, ExtrudeParams } from '../three/utils/elementTo3D.ts';
import { triggerDownload } from './download.ts';
import { furnitureObject3D } from '../library/furniture3D.ts';
import { getProjectUnits } from '../utils/units.ts';
import { unitsPerMetre } from './drawing/plan.ts';
import type { GeometryContext } from '../elements/archetypes.ts';
import { buildGeometryContext } from '../adapters/svg/buildContext.ts';
import { curtainWallModule, type CurtainWallFacts } from '../elements/curtain_wall.tsx';
import { roofModule } from '../elements/roof.tsx';
import { wallModule } from '../elements/wall.tsx';
import { structureWallModule } from '../elements/structure_wall.tsx';
import { wallSolid } from '../elements/_lineWallShared.tsx';
import { roofGeometryFromSolution } from '../three/utils/roofGeometry.ts';
import { buildCrossLevelIndex } from '../model/crossLevel.ts';
import { curtainWallPieces } from '../elements/curtainWallLayout.ts';
import { doorParts } from '../elements/_opening3D.tsx';
import { bimMaterialAppearance, resolveBimMaterial } from '../three/utils/bimMaterials.ts';

// Color palette per table name (matches editor 2D layer styles)
const TABLE_COLORS: Record<string, number> = {
  wall:             0x1a1a2e,
  curtain_wall:     0x7ec8e3,
  column:           0x2d2d2d,
  door:             0x0077b6,
  window:           0x48cae4,
  slab:             0xadb5bd,
  space:            0x3a86ff,
  stair:            0xf4a261,
  structure_wall:   0x4a4e69,
  structure_column: 0x6c757d,
  structure_slab:   0x868e96,
  beam:             0x9b5de5,
  brace:            0x9b5de5,
  duct:             0x00b4d8,
  pipe:             0x48bfe3,
  cable_tray:       0x90be6d,
  conduit:          0x43aa8b,
  equipment:        0xf94144,
  terminal:         0xf3722c,
};

const DEFAULT_COLOR = 0x888888;

export async function exportGltf(project: ProjectData, modelName: string): Promise<void> {
  const three = await import('three');
  const { Scene, Mesh, BoxGeometry, ExtrudeGeometry, MeshStandardMaterial, Shape, Group } = three;
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');

  const scene = new Scene();
  scene.name = modelName;

  const levelElevations = new Map<string, number>();
  for (const level of project.levels) {
    levelElevations.set(level.id, level.elevation);
  }

  // Material cache per table name
  type MatType = InstanceType<typeof MeshStandardMaterial>;
  const materials = new Map<string, MatType>();
  function getMaterial(tableName: string): MatType {
    let mat = materials.get(tableName);
    if (!mat) {
      const color = TABLE_COLORS[tableName] ?? DEFAULT_COLOR;
      mat = new MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.1 });
      materials.set(tableName, mat);
    }
    return mat;
  }

  const upm = unitsPerMetre(getProjectUnits({ project }));
  const crossLevel = buildCrossLevelIndex(project);
  for (const level of project.levels) {
    const floor = project.floors.get(level.id);
    if (!floor) continue;

    const elements = parseFloorLayers(floor.layers);
    const group = new Group();
    group.name = `Level: ${level.name || level.id}`;

    let ctx: GeometryContext | undefined;
    for (const el of elements) {
      // Library components: their merged low-poly mesh (vertex colours).
      const fu = furnitureObject3D(el, level.elevation, upm);
      if (fu) { group.add(fu); continue; }
      if (el.tableName === 'curtain_wall') {
        // Members, panels and doors as the 3D view draws them.
        ctx ??= buildGeometryContext({
          level, allLevels: project.levels, allElements: new Map(elements.map(e => [e.id, e])),
          mepSystems: project.mepSystems, types: project.types, crossLevel, unitsPerMetre: upm,
        });
        const facts = curtainWallModule.geometry(el, ctx);
        if (facts) {
          const g = curtainWallGltf(facts, three);
          g.name = `${el.tableName}:${el.id}`;
          group.add(g);
        }
        continue;
      }
      // Sloped roofs and walls attached to a roof: the 3D view's solids.
      const solidModule = el.tableName === 'roof' ? roofModule
        : el.attrs.top_attach_id && el.tableName === 'wall' ? wallModule
          : el.attrs.top_attach_id && el.tableName === 'structure_wall' ? structureWallModule : null;
      if (solidModule) {
        ctx ??= buildGeometryContext({
          level, allLevels: project.levels, allElements: new Map(elements.map(e => [e.id, e])),
          mepSystems: project.mepSystems, types: project.types, crossLevel, unitsPerMetre: upm,
        });
        const facts = solidModule.geometry(el, ctx) as any;
        const geo = !facts ? null : el.tableName === 'roof'
          ? roofGeometryFromSolution(facts.solution, facts.vertices, facts.baseY, facts.thickness, facts.holes)
          : wallSolid(facts, facts.footprint);
        if (geo) {
          const mesh = new Mesh(geo, getMaterial(el.tableName));
          mesh.name = `${el.tableName}:${el.id}`;
          group.add(mesh);
          continue;
        }
      }
      const params = elementTo3DParams(el, level.elevation, levelElevations);
      if (!params) continue;

      const mesh = params.kind === 'box'
        ? createBoxMesh(params, getMaterial(el.tableName), BoxGeometry, Mesh)
        : createExtrudeMesh(params, getMaterial(el.tableName), ExtrudeGeometry, Shape, Mesh);

      if (mesh) {
        mesh.name = `${el.tableName}:${el.id}`;
        group.add(mesh);
      }
    }

    if (group.children.length > 0) scene.add(group);
  }

  const exporter = new GLTFExporter();
  const glb = await exporter.parseAsync(scene, { binary: true }) as ArrayBuffer;
  const blob = new Blob([glb], { type: 'model/gltf-binary' });
  triggerDownload(blob, `${modelName}.glb`);

  // Dispose resources
  for (const mat of materials.values()) mat.dispose();
}

function createBoxMesh(
  p: BoxParams,
  material: any,
  BoxGeometry: any,
  Mesh: any,
) {
  const geo = new BoxGeometry(p.sx, p.sy, p.sz);
  const mesh = new Mesh(geo, material);
  mesh.position.set(p.cx, p.cy, p.cz);
  mesh.rotation.y = p.rotY;
  return mesh;
}

/** Curtain wall pieces (curtainWallPieces) → one group of meshes in the 3D view's frame (Y up, plan Y = −Z). */
function curtainWallGltf(f: CurtainWallFacts, three: typeof import('three')) {
  const { Group, Mesh, BoxGeometry, CylinderGeometry, MeshStandardMaterial } = three;
  const mats = new Map<string, InstanceType<typeof MeshStandardMaterial>>();
  const mat = (name: string) => {
    let m = mats.get(name);
    if (!m) {
      const { color, opacity } = bimMaterialAppearance(resolveBimMaterial(name, 'curtain_wall'));
      m = new MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.2, transparent: opacity < 1, opacity });
      mats.set(name, m);
    }
    return m;
  };
  const out = new Group();
  for (const p of curtainWallPieces(f)) {
    if (p.role === 'door') {
      const door = new Group();
      door.position.set(p.c.x, p.z0 + p.h / 2, -p.c.y);
      door.rotation.y = p.angle;
      const parts = doorParts({ length: p.along, height: p.h, strokeWidth: p.across, operation: p.kind === 'double_door' ? 'double_swing' : 'single_swing' });
      for (const q of parts) {
        const m = new Mesh(new BoxGeometry(...q.size), mat(q.role === 'frame' ? f.frameMaterial : f.panelMaterial));
        m.position.set(...q.pos);
        door.add(m);
      }
      out.add(door);
      continue;
    }
    const geo = p.round
      ? (p.role === 'mullion' ? new CylinderGeometry(p.along / 2, p.along / 2, p.h, 16) : new CylinderGeometry(p.h / 2, p.h / 2, p.along, 16))
      : new BoxGeometry(p.along, p.h, p.across);
    const m = new Mesh(geo, mat(p.material));
    m.position.set(p.c.x, p.z0 + p.h / 2, -p.c.y);
    m.rotation.set(0, p.angle, p.round && p.role !== 'mullion' ? Math.PI / 2 : 0);
    out.add(m);
  }
  return out;
}

function createExtrudeMesh(
  p: ExtrudeParams,
  material: any,
  ExtrudeGeometry: any,
  Shape: any,
  Mesh: any,
) {
  if (p.vertices.length < 3) return null;
  const shape = new Shape();
  // SVG Y → 3D Z: shape is on XZ, extruded along Y
  shape.moveTo(p.vertices[0].x, p.vertices[0].y);
  for (let i = 1; i < p.vertices.length; i++) {
    shape.lineTo(p.vertices[i].x, p.vertices[i].y);
  }
  shape.closePath();

  const geo = new ExtrudeGeometry(shape, { depth: p.height, bevelEnabled: false });
  const mesh = new Mesh(geo, material);
  // ExtrudeGeometry extrudes along Z by default; rotate so extrusion goes along Y
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = p.baseY;
  return mesh;
}
