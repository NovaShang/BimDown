/**
 * Data source abstraction — allows the editor to work with any backend.
 * Implement this interface for custom data sources.
 */

export interface DataSource {
  /** Fetch text content from a path relative to the project root */
  fetchText(path: string): Promise<string | null>;
  /** Write text content to a path */
  saveFile(path: string, content: string): Promise<void>;
  /** Subscribe to file changes. Returns unsubscribe function. */
  watchChanges(onFileChanged: (path: string) => void): () => void;
  /** Resolve a project-relative path to a full URL for direct loading (e.g. by Three.js loaders) */
  resolveUrl(path: string): string;
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

    resolveUrl(path: string): string {
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
