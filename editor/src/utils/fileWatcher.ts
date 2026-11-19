/**
 * SSE client that listens for file changes in sample_data.
 * Connects to /api/watch endpoint on the Vite dev server.
 */
export function connectFileWatcher(
  onFileChanged: (path: string) => void,
): () => void {
  let es: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout>;

  function connect() {
    es = new EventSource('/api/watch');

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'change' && data.path) {
          onFileChanged(data.path);
        }
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      es?.close();
      // Reconnect after 2 seconds
      reconnectTimer = setTimeout(connect, 2000);
    };
  }

  connect();

  return () => {
    clearTimeout(reconnectTimer);
    es?.close();
  };
}
