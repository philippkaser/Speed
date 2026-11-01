import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const SERVER_PORT = Number(process.env.SPEED_SERVER_PORT ?? 3001)

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    // runtime errors can repeat every frame; do not stream them into the dev server
    forwardConsole: false,
    proxy: {
      '/ws': { target: `ws://localhost:${SERVER_PORT}`, ws: true },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
  },
  worker: { format: 'es' },
})
