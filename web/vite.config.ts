import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// В разработке (npm run dev) запросы к API и сокетам уходят на сервер :8080.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: { '/api': 'http://localhost:8080', '/socket.io': { target: 'http://localhost:8080', ws: true } },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1000 },
});
