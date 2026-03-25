import type { ProjectData } from '../types.ts';
import { parseFloorLayers } from '../model/parse.ts';
import { elementTo3DParams } from '../three/utils/elementTo3D.ts';
import type { BoxParams, ExtrudeParams } from '../three/utils/elementTo3D.ts';
import { triggerDownload } from './download.ts';

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
  const { Scene, Mesh, BoxGeometry, ExtrudeGeometry, MeshStandardMaterial, Shape, Group } = await import('three');
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

  for (const level of project.levels) {
    const floor = project.floors.get(level.id);
    if (!floor) continue;

    const elements = parseFloorLayers(floor.layers);
    const group = new Group();
    group.name = `Level: ${level.name || level.id}`;

    for (const el of elements) {
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
