import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import path from 'path'

export default defineConfig({
  base: './',
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              // selfsigned + transitive @peculiar/* depend on tslib, whose CJS
              // shape rolldown (vite 8) bundles incorrectly — externalize so it
              // resolves from node_modules at runtime.
              external: ['@lydell/node-pty', 'ws', 'bufferutil', 'utf-8-validate', 'selfsigned', '@openai/codex-sdk', '@anthropic-ai/claude-agent-sdk']
            }
          }
        }
      },
      {
        entry: 'electron/preload.ts',
        onstart(options) {
          options.reload()
        },
        vite: {
          build: {
            outDir: 'dist-electron'
          }
        }
      },
      {
        // Headless server entry — runs without Electron. Bundled separately
        // so it can be packaged as a CLI (bin/bat-server.js).
        entry: 'electron/server-cli.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              // electron must stay external — the CLI runs in plain Node and
              // never imports it (only type-only references survive compile).
              external: ['electron', '@lydell/node-pty', 'ws', 'bufferutil', 'utf-8-validate', 'selfsigned', '@openai/codex-sdk', '@anthropic-ai/claude-agent-sdk']
            }
          }
        }
      }
    ])
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  build: {
    rollupOptions: {
      external: ['@lydell/node-pty'],
      output: {
        // vite 8 ships rolldown, whose manualChunks accepts a function only
        manualChunks: (id) => {
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) return 'react-vendor'
          if (id.includes('node_modules/@xterm/')) return 'xterm'
          if (id.includes('node_modules/highlight.js/')) return 'hljs'
        }
      }
    }
  }
})
