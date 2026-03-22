import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'

const sampleDataDir = path.resolve(__dirname, '..', 'sample_data')

export default defineConfig({
  plugins: [
    {
      name: 'serve-sample-data',
      configureServer(server) {
        // Track SSE clients for file watch notifications
        const watchClients = new Set<import('http').ServerResponse>()

        // Watch sample_data for external changes
        let selfWritePaths = new Map<string, number>()
        fs.watch(sampleDataDir, { recursive: true }, (_event, filename) => {
          if (!filename) return
          const normalized = filename.replace(/\\/g, '/')
          // TODO(Collaborative): This time-based debounce (2s) prevents fs.watch double-fires on Windows
          // from causing infinite reloads and destroying the local Undo history. 
          // However, if an AI or external agent modifies the file within 2s of the user's manual save, 
          // their changes will be incorrectly ignored, leading to data divergence.
          // Future SaaS architectures must move to CRDTs (like Yjs) or Content Hashing instead of fs.watch.
          // Skip changes we made ourselves (via /api/save) within the last 2 seconds
          if (selfWritePaths.has(normalized)) {
            const time = selfWritePaths.get(normalized)!
            if (Date.now() - time < 2000) return
          }
          const data = JSON.stringify({ type: 'change', path: normalized })
          for (const client of watchClients) {
            client.write(`data: ${data}\n\n`)
          }
        })

        server.middlewares.use((req, res, next) => {
          const url = req.url || ''

          // POST /api/save — write files to sample_data
          if (url === '/api/save' && req.method === 'POST') {
            let body = ''
            req.on('data', (chunk: Buffer) => { body += chunk.toString() })
            req.on('end', () => {
              try {
                const { model, files } = JSON.parse(body) as { model?: string; files: { path: string; content: string }[] }
                const modelDir = model ? path.join(sampleDataDir, model) : sampleDataDir
                for (const file of files) {
                  const filePath = path.join(modelDir, file.path)
                  // Ensure no path traversal
                  if (!filePath.startsWith(sampleDataDir)) continue
                  // Track as self-write to suppress watch events (path relative to sampleDataDir)
                  const relPath = model ? `${model}/${file.path}` : file.path
                  selfWritePaths.set(relPath.replace(/\\/g, '/'), Date.now())
                  // Ensure directory exists
                  const dir = path.dirname(filePath)
                  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
                  fs.writeFileSync(filePath, file.content, 'utf-8')
                }
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: true, written: files.length }))
              } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: String(err) }))
              }
            })
            return
          }

          // GET /api/watch — SSE stream for file change notifications
          if (url === '/api/watch' && req.method === 'GET') {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            })
            res.write('data: {"type":"connected"}\n\n')
            watchClients.add(res)
            req.on('close', () => { watchClients.delete(res) })
            return
          }

          // Serve sample_data files
          if (!url.startsWith('/sample_data/')) return next()

          const relPath = url.slice('/sample_data/'.length)
          const filePath = path.join(sampleDataDir, relPath)

          if (!filePath.startsWith(sampleDataDir)) return next()

          if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const ext = path.extname(filePath)
            const contentType = ext === '.svg' ? 'image/svg+xml'
              : ext === '.csv' ? 'text/csv; charset=utf-8'
              : ext === '.json' ? 'application/json'
              : 'application/octet-stream'
            res.setHeader('Content-Type', contentType)
            fs.createReadStream(filePath).pipe(res)
          } else {
            next()
          }
        })
      },
    },
    react(),
  ],
  server: {
    port: 5174,
    fs: {
      allow: ['.', '..'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
