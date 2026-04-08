import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import crypto from 'crypto'
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

        // Watch sample_data for external changes (content-hash based self-write suppression)
        const selfWriteHashes = new Map<string, string>()
        fs.watch(sampleDataDir, { recursive: true }, (_event, filename) => {
          if (!filename) return
          const normalized = filename.replace(/\\/g, '/')
          // Read the file and compare its content hash to what we last wrote.
          // If identical, this is our own write echoing back — suppress it.
          const absPath = path.join(sampleDataDir, normalized)
          try {
            if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return
          } catch { return }
          let content: string
          try { content = fs.readFileSync(absPath, 'utf-8') } catch { return }
          const hash = crypto.createHash('md5').update(content).digest('hex')
          if (selfWriteHashes.get(normalized) === hash) return
          // Clean up stale hash entry (file was externally modified)
          selfWriteHashes.delete(normalized)
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
                  // Track content hash to suppress our own write from fs.watch
                  const relPath = model ? `${model}/${file.path}` : file.path
                  selfWriteHashes.set(relPath.replace(/\\/g, '/'), crypto.createHash('md5').update(file.content).digest('hex'))
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
            // Return 404 for missing sample_data files instead of falling through
            // to Vite's SPA fallback (which would serve index.html as 200)
            res.writeHead(404)
            res.end()
          }
        })
      },
    },
    tailwindcss(),
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
