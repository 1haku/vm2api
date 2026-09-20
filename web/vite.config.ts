import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appVersion = fs
  .readFileSync(path.resolve(import.meta.dirname, '../VERSION'), 'utf8')
  .trim()

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(path.dirname(fileURLToPath(import.meta.url)), './src'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target:
          process.env.VM2API_API_PROXY ||
          process.env.KIN_API_PROXY ||
          'http://127.0.0.1:8787',
        changeOrigin: true,
        secure: true,
      },
    },
  },
})
