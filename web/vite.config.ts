import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.API_URL ?? 'http://localhost:3000';

// Versão do chat: cada build ganha um id, gravado em dist/build.json e embutido na página (__BUILD_ID__). Uma aba
// aberta compara os dois e oferece "Recarregar" quando sai outra versão (lib/call/build.ts).
function buildInfo(): Plugin {
  const id = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  const body = JSON.stringify({ id });
  return {
    name: 'wescc-build-info',
    config: () => ({ define: { __BUILD_ID__: JSON.stringify(id) } }),
    configureServer(server) {
      server.middlewares.use('/build.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(body);
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'build.json', source: body });
    },
  };
}

export default defineConfig({
  plugins: [react(), buildInfo()],
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
      // Mídia das chamadas em grupo: o chat repassa ao LiveKit (sinalização por websocket e /sfu/rtc/v1/validate).
      '/sfu': { target, ws: true },
      '/hooks': target,
      '/saml': target,
      '/oauth': target,
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // O piso do design system (light-dark() nativo). Abaixo dele o minificador troca light-dark() por variáveis
    // resolvidas no :root, e as ilhas escuras (barra lateral, chamada) ficam claras no tema claro. Navegadores mais
    // antigos caem no tema claro pelo bloco @supports de tokens.css.
    cssTarget: ['chrome123', 'edge123', 'firefox120', 'safari17.5'],
    // O livekit-client só carrega na primeira chamada em grupo (import() de lib/call/sfu.ts), num pedaço só dele.
    rolldownOptions: { output: { codeSplitting: { groups: [{ name: 'livekit', test: /node_modules[\\/]livekit-client/ }] } } },
  },
});
