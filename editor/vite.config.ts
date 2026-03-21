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
        server.middlewares.use((req, res, next) => {
          const url = req.url || ''
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
