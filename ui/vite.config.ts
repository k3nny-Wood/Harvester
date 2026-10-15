import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri expects a fixed dev port and does not want Vite to clear the terminal.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // in a browser the page talks to harvester-server (HARVESTER_WEB_BIND, 127.0.0.1:8787 by default here)
  server: {
    port: 1420,
    strictPort: true,
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:8787', '/ws': { target: 'ws://127.0.0.1:8787', ws: true } },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
