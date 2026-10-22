import cron from 'node-cron';
import { pool, query } from './db/pool';
import { recoverInterrupted } from './importer/operations';
import { bus } from './realtime/bus';
import { cleanupStaleConnections } from './realtime/ws';
import { runRetention } from './services/retention';
import { getSetting } from './services/settings';

// Tarefas periódicas. Cada tarefa usa um advisory lock para rodar em uma só instância.
export async function withLock(key: number, fn: () => Promise<unknown>) {
  // O advisory lock é da conexão: trava e destrava precisam usar o mesmo cliente.
  const client = await pool.connect();
  try {
    const r = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [key]);
    if (!r.rows[0].ok) return;
    try {
      await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [key]);
    }
  } finally {
    client.release();
  }
}

export function startScheduler(log: (m: string) => void) {
  const tasks: { stop(): void }[] = [];
  const heartbeat = setInterval(() => {
    void query('UPDATE instances SET last_seen = now() WHERE id = $1', [bus.origin]).catch(() => {});
  }, 20_000);

  tasks.push(
    cron.schedule('* * * * *', () => {
      void withLock(727101, async () => {
        await cleanupStaleConnections();
        await recoverInterrupted();
        await query(`DELETE FROM instances WHERE last_seen < now() - interval '1 day'`);
        await query(`DELETE FROM realtime_spill WHERE created_at < now() - interval '5 minutes'`);
        await query(`DELETE FROM sessions WHERE expires_at < now()`);
        await query(`DELETE FROM login_attempts WHERE updated_at < now() - interval '1 day' AND (blocked_until IS NULL OR blocked_until < now())`);
      }).catch((e) => log(`limpeza falhou: ${e.message}`));
    }),
  );

  // Omnichannel: fila, chats abandonados, espera e tempo máximo na fila.
  const omni = setInterval(() => {
    void withLock(727104, async () => {
      const { runOmnichannelTimers } = await import('./omnichannel/service');
      await runOmnichannelTimers();
      const { sweepCalls } = await import('./services/calls');
      await sweepCalls();
    }).catch((e) => log(`omnichannel falhou: ${e.message}`));
  }, 30_000);

  let retentionExpr = '';
  let retentionTask: { stop(): void } | null = null;
  let ldapExpr = '';
  let ldapTask: { stop(): void } | null = null;
  const reschedule = () => {
    const expr = getSetting<string>('RetentionPolicy_Precision') || '0 * * * *';
    if (expr !== retentionExpr && cron.validate(expr)) {
      retentionTask?.stop();
      retentionExpr = expr;
      retentionTask = cron.schedule(expr, () => {
        void withLock(727102, async () => {
          const r = await runRetention();
          if (r.removed) log(`retenção: ${r.removed} itens removidos em ${r.rooms} salas`);
        }).catch((e) => log(`retenção falhou: ${e.message}`));
      });
    }
    const lexpr = getSetting<boolean>('LDAP_Background_Sync') ? String(getSetting<string>('LDAP_Background_Sync_Interval') ?? '').trim() : '';
    if (lexpr !== ldapExpr) {
      ldapTask?.stop();
      ldapTask = null;
      ldapExpr = lexpr;
      if (lexpr && !cron.validate(lexpr)) log(`sincronização LDAP: expressão cron inválida "${lexpr}"; a sincronização automática está parada.`);
      // runScheduledLdapSync pega o lock sozinho (e fica quieto quando outra instância já está sincronizando).
      else if (lexpr) ldapTask = cron.schedule(lexpr, () => void import('./ldap/ldap').then((m) => m.runScheduledLdapSync(log)));
    }
  };
  reschedule();
  const re = setInterval(reschedule, 60_000);

  return () => {
    clearInterval(heartbeat);
    clearInterval(omni);
    clearInterval(re);
    for (const t of tasks) t.stop();
    retentionTask?.stop();
    ldapTask?.stop();
  };
}
