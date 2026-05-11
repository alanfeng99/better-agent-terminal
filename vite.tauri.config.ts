import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// Tauri-flavoured vite config. Same renderer pipeline as vite.config.ts,
// minus vite-plugin-electron — Tauri provides its own host runtime, so we
// never want to spawn Electron during `tauri dev` or `tauri build`.
//
// The output goes to dist-tauri/ so it doesn't collide with the Electron
// build output in dist/. Tauri's tauri.conf.json points at the same path.

export default defineConfig({
  base: './',
  plugins: [
    react(),
  ],
  // Tauri expects fixed dev server settings so the Rust shell can hand the
  // window over to vite during development.
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    // Avoid conflict with the Electron HMR client; Tauri 2 listens here.
    host: '127.0.0.1',
    hmr: { host: '127.0.0.1', port: 5174 },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist-tauri',
    emptyOutDir: true,
    rollupOptions: {
      // Same manualChunks as the Electron build keeps bundle layout
      // comparable for diffing.
      output: {
        manualChunks: (id) => {
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) return 'react-vendor'
          if (id.includes('node_modules/@xterm/')) return 'xterm'
          if (id.includes('node_modules/highlight.js/')) return 'hljs'
        },
      },
    },
  },
})
