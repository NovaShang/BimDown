// Browser-only project sources shared by the standalone app and the web app:
// a local folder (File System Access API, read-write + live reload), an
// in-memory project, and .zip import/export. Separate entry point
// (`bimdown-editor/data-sources`) so the main barrel doesn't pull in JSZip.
export { createFileSystemDataSource, canPickDirectory, pickDirectory } from './fileSystem.ts';
export { createMemoryDataSource } from './memory.ts';
export type { MemoryDataSource, ProjectFileMap } from './memory.ts';
export { loadProjectFromZip, downloadProjectAsZip, isBinaryFile } from './zip.ts';
