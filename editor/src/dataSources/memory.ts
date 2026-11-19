import type { DataSource } from '../utils/dataSource.ts';
import { createFileSystemDataSource } from './fileSystem.ts';

export type ProjectFileMap = Map<string, string | ArrayBuffer>;

export interface MemoryDataSource {
  dataSource: DataSource;
  getFiles(): ProjectFileMap;
  /** Write every text file into a local folder and return a DataSource on it. */
  transitionToFs(handle: FileSystemDirectoryHandle): Promise<DataSource>;
}

/**
 * An in-memory project (e.g. opened from a .zip). Nothing is persisted:
 * edits live until the page is closed.
 */
export function createMemoryDataSource(initialFiles?: ProjectFileMap): MemoryDataSource {
  const files: ProjectFileMap = new Map(initialFiles ?? []);

  const dataSource: DataSource = {
    async fetchText(path) {
      const content = files.get(path);
      if (content == null) return null;
      if (typeof content === 'string') return content;
      // Binary → decode as UTF-8 (shouldn't normally be needed for text files)
      return new TextDecoder().decode(content);
    },

    async listFiles() {
      return [...files.keys()];
    },

    async saveFile(path, content) {
      files.set(path, content);
    },

    async saveBinary(path, data) {
      files.set(path, data.slice(0));
    },

    async fetchBinary(path) {
      const content = files.get(path);
      if (content == null) return null;
      return typeof content === 'string' ? new TextEncoder().encode(content).buffer : content.slice(0);
    },

    async deleteFile(path) {
      files.delete(path);
    },

    // The editor is the only writer; its own saves are already in its state.
    watchChanges() {
      return () => {};
    },

    async resolveUrl(path) {
      const content = files.get(path);
      if (content == null) return '';
      const blob = content instanceof ArrayBuffer
        ? new Blob([content])
        : new Blob([content], { type: 'text/plain' });
      return URL.createObjectURL(blob);
    },
  };

  return {
    dataSource,
    getFiles: () => new Map(files),
    async transitionToFs(handle) {
      const fsDs = createFileSystemDataSource(handle);
      for (const [path, content] of files) {
        if (typeof content === 'string') {
          await fsDs.saveFile(path, content);
        } else if (path.startsWith('underlays/')) {
          // Underlays were imported by the user and are referenced by global/underlay.csv
          await fsDs.saveBinary!(path, content);
        }
        // Other binary files (GLB etc.) are not saved to FS — they're read-only mesh assets
      }
      return fsDs;
    },
  };
}
