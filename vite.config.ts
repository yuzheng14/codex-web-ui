import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
const metadata = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};
export default defineConfig({
  define: { 'import.meta.env.VITE_COVRO_VERSION': JSON.stringify(metadata.version) },
  plugins: [react()],
  // Linked or copied dependency trees must share the renderer's React runtime.
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:8787', '/ws': { target: 'ws://127.0.0.1:8787', ws: true } },
  },
  build: { outDir: 'dist/web' },
});
