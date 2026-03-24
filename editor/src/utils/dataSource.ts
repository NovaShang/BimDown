/**
 * Data source abstraction — allows the editor to work with either
 * local Vite dev server or remote SaaS API.
 */

export interface DataSource {
  /** Fetch text content from a path relative to the project root */
  fetchText(path: string): Promise<string | null>;
  /** Write text content to a path */
  saveFile(path: string, content: string): Promise<void>;
  /** Subscribe to file changes. Returns unsubscribe function. */
  watchChanges(onFileChanged: (path: string) => void): () => void;
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

/**
 * API data source — loads from /api/projects/{projectId}/files/ via SaaS API.
 * File watching via WebSocket /api/projects/{projectId}/ws.
 */
export function createApiDataSource(projectId: string): DataSource {
  const filesBase = `/api/projects/${projectId}/files`;
  // Track self-writes to suppress WebSocket echo (path → timestamp)
  const selfWrites = new Map<string, number>();
  const SELF_WRITE_TTL = 2000; // ignore WS events for 2s after our own write

  return {
    async fetchText(path: string): Promise<string | null> {
      try {
        const resp = await fetch(`${filesBase}/${path}`, { credentials: 'include' });
        if (!resp.ok) return null;
        return await resp.text();
      } catch {
        return null;
      }
    },

    async saveFile(path: string, content: string): Promise<void> {
      selfWrites.set(path, Date.now());
      const resp = await fetch(`${filesBase}/${path}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'text/plain' },
        body: content,
      });
      if (!resp.ok) throw new Error(`Save failed: ${resp.status}`);
    },

    watchChanges(onFileChanged: (path: string) => void): () => void {
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${wsProtocol}//${window.location.host}/api/projects/${projectId}/ws`;

      let ws: WebSocket | null = null;
      let reconnectTimer: ReturnType<typeof setTimeout>;
      let closed = false;

      function connect() {
        if (closed) return;
        ws = new WebSocket(wsUrl);

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if ((data.type === 'file:updated' || data.type === 'file:deleted') && data.path) {
              // Skip events caused by our own writes
              const writeTime = selfWrites.get(data.path);
              if (writeTime && Date.now() - writeTime < SELF_WRITE_TTL) return;
              selfWrites.delete(data.path);
              onFileChanged(data.path);
            }
          } catch { /* ignore */ }
        };

        ws.onclose = () => {
          if (!closed) reconnectTimer = setTimeout(connect, 2000);
        };

        ws.onerror = () => {
          ws?.close();
        };
      }

      connect();
      return () => { closed = true; clearTimeout(reconnectTimer); ws?.close(); };
    },
  };
}
