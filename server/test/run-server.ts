import { spawn } from 'node:child_process';
import path from 'node:path';

// Sobe o servidor de verdade (src/index.ts) com outro ambiente e devolve o código de saída, o stdout e o stderr.
// As variáveis de HTTPS, segredos, portas e proxy do ambiente dos testes ficam de fora.
export function runServer(env: Record<string, string>, args: string[] = []): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const serverDir = path.resolve(import.meta.dirname, '..');
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(TLS_|LIVEKIT_|TRUST_PROXY$|HTTP_REDIRECT_PORT$|INTERNAL_PORT$|PORT$|DATABASE_URL)/.test(k)),
  );
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', ...args], { cwd: serverDir, env: { ...clean, DISABLE_CRON: '1', ...env } });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => p.kill('SIGKILL'), 20_000);
    p.on('error', reject);
    p.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
