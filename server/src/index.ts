import type http from 'node:http';
import type tls from 'node:tls';

// Só imports dinâmicos aqui: o config.ts lê as variáveis e os arquivos de segredo ao ser carregado, e um erro
// dele (TRUST_PROXY, *_FILE, portas) precisa chegar a este arquivo para sair só com a mensagem.

// Erro ao subir: só a mensagem em português (o serviço do Windows tenta de novo em 5 s).
function fatal(message: string): never {
  console.error(message);
  process.exit(1);
}

const isConfigError = (e: unknown): e is Error => e instanceof Error && e.name === 'ConfigError';

// node dist/index.js --check-tls: confere o certificado das variáveis TLS_* com o mesmo código do serviço e responde
// em JSON (só ASCII, para o PowerShell 5.1 ler sem estragar os acentos). Usado pelo instalador do Windows.
async function checkTlsOnly() {
  const print = (o: object) => console.log(JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`));
  try {
    const { loadTls, probeCertificate } = await import('./tls');
    const opts = loadTls();
    if (!opts) throw new Error('Nenhum certificado definido (TLS_PFX_FILE, ou TLS_CERT_FILE e TLS_KEY_FILE).');
    const s = await probeCertificate(opts);
    print(s);
    process.exit(s.error ? 2 : 0);
  } catch (e) {
    print({ enabled: false, error: (e as Error).message });
    process.exit(2);
  }
}

async function main() {
  let config: typeof import('./config').config;
  try {
    ({ config } = await import('./config'));
  } catch (e) {
    if (isConfigError(e)) fatal(e.message);
    throw e;
  }
  const { certificateSummary, checkCertificate, listenErrorMessage, loadTls, needsAttention, portConflict, startHttpRedirect, startInternalListener, watchTls } =
    await import('./tls');
  let tlsOptions: ReturnType<typeof loadTls> = null;
  try {
    tlsOptions = loadTls();
  } catch (e) {
    fatal((e as Error).message);
  }
  const conflict = portConflict(config, !!tlsOptions);
  if (conflict) fatal(conflict);

  const [{ buildApp }, { boot }, { pool }, { bus }, { startScheduler }] = await Promise.all([
    import('./app'),
    import('./boot'),
    import('./db/pool'),
    import('./realtime/bus'),
    import('./scheduler'),
  ]);
  const app = await buildApp({ https: tlsOptions });
  const log = (m: string) => app.log.info(m);
  const warn = (m: string) => app.log.warn(m);
  if (tlsOptions && !config.siteUrl.startsWith('https://')) {
    warn(`Com HTTPS ligado, SITE_URL deve começar com https:// (hoje: ${config.siteUrl}).`);
  }
  await boot(log);
  // Porta ocupada: sai sem deixar esta instância registrada no banco.
  const listenFailed = async (e: NodeJS.ErrnoException, port: number) => {
    await pool.query('DELETE FROM instances WHERE id = $1', [bus.origin]).catch(() => {});
    fatal(listenErrorMessage(e, port));
  };
  const stop = config.disableCron ? () => {} : startScheduler(log);
  await app.listen({ port: config.port, host: config.host }).catch((e) => listenFailed(e, config.port));

  const servers: http.Server[] = [];
  const extra = (s: http.Server, port: number) => {
    s.on('error', (e: NodeJS.ErrnoException) => void listenFailed(e, port));
    servers.push(s);
  };
  let unwatch = () => {};
  let certTimer: NodeJS.Timeout | null = null;
  if (tlsOptions) {
    unwatch = watchTls(app.server as unknown as tls.Server, log, config.tls, { warn });
    extra(startInternalListener(app, config.internalPort, log), config.internalPort);
    // Avisa no log quando faltam menos de 30 dias para o certificado vencer.
    const check = () =>
      checkCertificate(config.port)
        .then((s) => (needsAttention(s) ? warn : log)(certificateSummary(s)))
        .catch((e) => warn(String(e?.message ?? e)));
    void check();
    certTimer = setInterval(check, 24 * 3600_000);
    certTimer.unref();
  }
  for (const p of config.httpRedirectPorts) extra(startHttpRedirect(p, log), p);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    // O WinSW espera 15 s antes de matar o processo: termina antes disso mesmo que algo trave.
    setTimeout(() => process.exit(0), 12_000).unref();
    stop();
    unwatch();
    if (certTimer) clearInterval(certTimer);
    for (const s of servers) s.close();
    await app.close();
    await pool.query('DELETE FROM presence_connections WHERE instance_id = $1', [bus.origin]).catch(() => {});
    await pool.query('DELETE FROM instances WHERE id = $1', [bus.origin]).catch(() => {});
    await bus.stop();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Ctrl+Break no Windows. O WinSW para o serviço com Ctrl+C, que o Node entrega como SIGINT.
  process.on('SIGBREAK', shutdown);
}

// Uma promessa rejeitada sem tratamento (por exemplo, uma tarefa em segundo plano com o banco fora do ar)
// é registrada em vez de derrubar o servidor inteiro.
process.on('unhandledRejection', (e) => {
  console.error('[processo] promessa rejeitada sem tratamento:', e);
});

(process.argv.includes('--check-tls') ? checkTlsOnly() : main()).catch((e) => {
  console.error(e);
  process.exit(1);
});
