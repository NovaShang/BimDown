import JSZip from 'jszip';
import type { ProjectFileMap } from './memory.ts';

/** Download a project as `<projectName>.zip`. */
export async function downloadProjectAsZip(
  files: ProjectFileMap,
  projectName = 'bimdown-project',
): Promise<void> {
  const zip = new JSZip();
  for (const [path, content] of files) {
    zip.file(path, content);
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${projectName}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** File extensions that must be read as binary (ArrayBuffer) instead of text. */
const BINARY_EXTENSIONS = new Set(['.glb', '.gltf', '.obj', '.bin', '.png', '.jpg', '.jpeg', '.webp', '.ktx2']);

export function isBinaryFile(path: string): boolean {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Unpack a BimDown project zip: text files as strings, meshes/images as
 * ArrayBuffers. Skips macOS metadata and strips a single wrapping root folder.
 */
export async function loadProjectFromZip(blob: Blob): Promise<ProjectFileMap> {
  const zip = await JSZip.loadAsync(blob);
  const files: ProjectFileMap = new Map();
  const promises: Promise<void>[] = [];

  zip.forEach((relativePath, entry) => {
    if (entry.dir) return;
    // Skip macOS resource forks and hidden files
    if (relativePath.startsWith('__MACOSX/') || relativePath.includes('/.__')) return;
    if (isBinaryFile(relativePath)) {
      promises.push(
        entry.async('arraybuffer').then((content) => {
          files.set(relativePath, content);
        }),
      );
    } else {
      promises.push(
        entry.async('string').then((content) => {
          files.set(relativePath, content);
        }),
      );
    }
  });

  await Promise.all(promises);

  // Detect single-root-folder wrapping and strip prefix
  const paths = [...files.keys()];
  if (paths.length > 0) {
    const firstSlash = paths[0]!.indexOf('/');
    if (firstSlash > 0) {
      const prefix = paths[0]!.slice(0, firstSlash + 1);
      if (paths.every((p) => p.startsWith(prefix))) {
        const stripped: ProjectFileMap = new Map();
        for (const [p, c] of files) {
          stripped.set(p.slice(prefix.length), c);
        }
        return stripped;
      }
    }
  }

  return files;
}
