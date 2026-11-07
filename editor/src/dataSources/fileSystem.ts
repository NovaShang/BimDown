import type { DataSource } from '../utils/dataSource.ts';

const POLL_INTERVAL = 10_000;

type PickerWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
};

/** True when the browser can open a local folder read-write (File System Access API: Chrome, Edge). */
export function canPickDirectory(): boolean {
  return typeof window !== 'undefined' && typeof (window as PickerWindow).showDirectoryPicker === 'function';
}

/**
 * Ask the user for a folder with read-write access. Rejects with an
 * `AbortError` DOMException when the picker is dismissed.
 */
export function pickDirectory(): Promise<FileSystemDirectoryHandle> {
  const picker = (window as PickerWindow).showDirectoryPicker;
  if (!picker) return Promise.reject(new Error('showDirectoryPicker is not supported'));
  return picker.call(window, { mode: 'readwrite' });
}

/** Dot-folders (.git, .claude, …) and node_modules are never project files. */
function isIgnored(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}

/** Recursively collect all files under a directory handle, returning relative paths → mtime. */
async function collectFiles(
  dir: FileSystemDirectoryHandle,
  prefix: string,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const entries = (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values();
  for await (const entry of entries) {
    if (isIgnored(entry.name)) continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === 'file') {
      const file = await (entry as FileSystemFileHandle).getFile();
      result.set(path, file.lastModified);
    } else if (entry.kind === 'directory') {
      const sub = await collectFiles(entry as FileSystemDirectoryHandle, path);
      for (const [k, v] of sub) result.set(k, v);
    }
  }
  return result;
}

async function getFile(root: FileSystemDirectoryHandle, path: string): Promise<File> {
  const parts = path.split('/');
  let dir = root;
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
  const fileHandle = await dir.getFileHandle(parts[parts.length - 1]!);
  return fileHandle.getFile();
}

/**
 * A local folder as a read-write DataSource. Edits are written straight to
 * disk; external changes (an AI agent or a text editor writing files) are
 * picked up by polling modification times every 10 s.
 */
export function createFileSystemDataSource(
  dirHandle: FileSystemDirectoryHandle,
): DataSource {
  // path → mtime of our own last write, so polling doesn't echo it back as an
  // external change (but a later external write to the same file still counts)
  const selfWrites = new Map<string, number>();

  return {
    async fetchText(path: string): Promise<string | null> {
      try {
        return await (await getFile(dirHandle, path)).text();
      } catch {
        return null;
      }
    },

    async listFiles(): Promise<string[]> {
      try {
        return [...(await collectFiles(dirHandle, '')).keys()];
      } catch {
        return [];
      }
    },

    async saveFile(path: string, content: string): Promise<void> {
      const parts = path.split('/');
      let dir: FileSystemDirectoryHandle = dirHandle;
      for (const part of parts.slice(0, -1)) {
        dir = await dir.getDirectoryHandle(part, { create: true });
      }
      const fileHandle = await dir.getFileHandle(parts[parts.length - 1]!, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(content);
      await writable.close();
      selfWrites.set(path, (await fileHandle.getFile()).lastModified);
    },

    async deleteFile(path: string): Promise<void> {
      const parts = path.split('/');
      let dir: FileSystemDirectoryHandle = dirHandle;
      try {
        for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
        await dir.removeEntry(parts[parts.length - 1]!);
      } catch (err) {
        if ((err as DOMException)?.name !== 'NotFoundError') throw err;
      }
      selfWrites.delete(path);
    },

    async resolveUrl(path: string): Promise<string> {
      try {
        return URL.createObjectURL(await getFile(dirHandle, path));
      } catch {
        return '';
      }
    },

    watchChanges(onFileChanged: (path: string) => void): () => void {
      let lastSnapshot = new Map<string, number>();
      let stopped = false;

      // Take initial snapshot
      collectFiles(dirHandle, '').then(snap => { lastSnapshot = snap; }).catch(() => {});

      const timer = setInterval(async () => {
        if (stopped) return;
        try {
          const current = await collectFiles(dirHandle, '');
          for (const [path, mtime] of current) {
            const prev = lastSnapshot.get(path);
            if (prev === mtime) continue;
            // Skip the version we wrote ourselves
            if (selfWrites.get(path) === mtime) continue;
            selfWrites.delete(path);
            onFileChanged(path);
          }
          lastSnapshot = current;
        } catch {
          // Directory may have been removed or permission revoked
        }
      }, POLL_INTERVAL);

      return () => {
        stopped = true;
        clearInterval(timer);
      };
    },
  };
}
