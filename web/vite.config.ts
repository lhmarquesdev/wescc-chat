import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
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

// Cópias comprimidas (.br e .gz) do JS, do CSS e dos SVGs do build: o servidor entrega a que o navegador aceitar
// (preCompressed do @fastify/static, server/src/app.ts), sem comprimir a cada pedido. O primeiro acesso cai de cerca de
// 2 MB para pouco mais de 0,6 MB.
function precompress(): Plugin {
  let outDir = '';
  return {
    name: 'wescc-precompress',
    apply: 'build',
    configResolved(c) {
      outDir = path.resolve(c.root, c.build.outDir);
    },
    writeBundle(_opts, bundle) {
      for (const name of Object.keys(bundle)) {
        if (!/\.(js|css|svg|json)$/.test(name)) continue;
        const file = path.join(outDir, name);
        const data = fs.readFileSync(file);
        if (data.length < 1024) continue;
        // Brotli 10: quase o tamanho do 11 em menos da metade do tempo de build.
        fs.writeFileSync(`${file}.br`, brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 10, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } }));
        fs.writeFileSync(`${file}.gz`, gzipSync(data, { level: 9 }));
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), buildInfo(), precompress()],
  resolve: { alias: { '@shared': path.resolve(import.meta.dirname, '../shared/src') } },
  server: {
    port: 5173,
    proxy: {
      '/api': target,
      '/avatar': target,
      '/file-upload': target,
      '/emoji-custom': target,
      // Figurinhas: só /sticker/<arquivo>; /stickers… são páginas do app.
      '^/sticker/': target,
      '/websocket': { target: target.replace('http', 'ws'), ws: true },
      // Mídia das chamadas em grupo: o chat repassa ao LiveKit (sinalização por websocket e /sfu/rtc/v1/validate).
      '/sfu': { target, ws: true },
      '/hooks': target,
      '/saml': target,
      '/oauth': target,
      // Integrações (Jira/Teams): retornos de OAuth do Jira e da conta de serviço do Teams
      '/integrations': target,
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
