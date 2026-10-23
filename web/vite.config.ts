import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.API_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@shared': path.resolve(import.meta.dirname, '../shared/src') } },
  server: {
    port: 5173,
    proxy: {
      '/api': target,
      '/avatar': target,
      '/file-upload': target,
      '/emoji-custom': target,
      '/websocket': { target: target.replace('http', 'ws'), ws: true },
      // O widget do visitante abre o websocket dele em /livechat/websocket.
      '/livechat': { target, ws: true },
      '/hooks': target,
      '/saml': target,
      '/oauth': target,
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
