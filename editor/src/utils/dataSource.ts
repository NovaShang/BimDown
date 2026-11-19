/**
 * Data source abstraction — allows the editor to work with any backend.
 * Implement this interface for custom data sources.
 */

export interface DataSource {
  /** Fetch text content from a path relative to the project root */
  fetchText(path: string): Promise<string | null>;
  /** Write text content to a path */
  saveFile(path: string, content: string): Promise<void>;
  /** Optional: delete a file (missing files are not an error). Needed to
   *  remove a level's folder, an emptied layer or a removed underlay; without
   *  it the files are left in place. */
  deleteFile?(path: string): Promise<void>;
  /** Subscribe to file changes. Returns unsubscribe function. */
  watchChanges(onFileChanged: (path: string) => void): () => void;
  /** Resolve a project-relative path to a loadable URL (e.g. for Three.js loaders).
   *  May create a blob URL for backends that don't serve files directly. */
  resolveUrl(path: string): Promise<string>;
  /** Optional: list all existing project files. When provided, the loader skips
   *  probing paths that aren't present, avoiding 404 storms on sparse projects. */
  listFiles?(): Promise<string[]>;
  /** Optional: write raw bytes (underlay images, PDFs, DXFs). Without it the
   *  editor can't import underlays into this source. */
  saveBinary?(path: string, data: ArrayBuffer): Promise<void>;
  /** Optional: read raw bytes. Falls back to fetching `resolveUrl(path)`. */
  fetchBinary?(path: string): Promise<ArrayBuffer | null>;
}

/** Read a binary file through `ds.fetchBinary`, else by fetching its URL. */
export async function fetchBinaryFile(ds: DataSource, path: string): Promise<ArrayBuffer | null> {
  if (ds.fetchBinary) return ds.fetchBinary(path);
  try {
    const url = await ds.resolveUrl(path);
    if (!url) return null;
    const resp = await fetch(url);
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    return resp.ok ? await resp.arrayBuffer() : null;
  } catch {
    return null;
  }
}

/**
 * Local data source — loads from /sample_data/{model}/ via Vite dev server.
 * File watching via SSE /api/watch.
 */
export function createLocalDataSource(model: string): DataSource {
  const base = `/sample_data/${model}`;

  return {
    async fetchText(path: string): Promise<string | null> {
      try {
        const resp = await fetch(`${base}/${path}`);
        if (!resp.ok) return null;
        return await resp.text();
      } catch {
        return null;
      }
    },

    async saveFile(path: string, content: string): Promise<void> {
      const resp = await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, files: [{ path, content }] }),
      });
      if (!resp.ok) throw new Error(`Save failed: ${resp.status}`);
    },

    async deleteFile(path: string): Promise<void> {
      const resp = await fetch('/api/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, paths: [path] }),
      });
      if (!resp.ok) throw new Error(`Delete failed: ${resp.status}`);
    },

    async resolveUrl(path: string): Promise<string> {
      return `${base}/${path}`;
    },

    watchChanges(onFileChanged: (path: string) => void): () => void {
      let es: EventSource | null = null;
      let reconnectTimer: ReturnType<typeof setTimeout>;

      function connect() {
        es = new EventSource('/api/watch');
        es.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'change' && data.path) {
              // Paths from Vite watcher: {model}/{levelId}/{fileName}
              const parts = data.path.split('/');
              if (parts.length >= 3 && parts[0] === model) {
                // Strip model prefix: levelId/fileName
                onFileChanged(parts.slice(1).join('/'));
              }
            }
          } catch { /* ignore */ }
        };
        es.onerror = () => {
          es?.close();
          reconnectTimer = setTimeout(connect, 2000);
        };
      }

      connect();
      return () => { clearTimeout(reconnectTimer); es?.close(); };
    },
  };
}
