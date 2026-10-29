// Chaves de advisory lock (pg_try_advisory_lock): uma por tarefa, nunca repetida. Quem criar tarefa nova anota aqui.
//   727001 migrações · 727101 limpeza (a cada minuto) · 727102 retenção · 727103 LDAP · 727104 (do atendimento
//   externo, removido: não reusar)
//   727105 importação · 727110 chamadas (varredura a cada 10 s; com hashtext(id), a trava de cada chamada; com 0, a
//   trava curta das entradas, sempre depois da trava da chamada)
//   727111 figurinhas (limpeza diária)
//   727120–727124 integrações Jira/Teams
//   727125 integrações: reserva da fila de tarefas (pg_advisory_xact_lock, só na transação curta da reserva)
//   727130 agenda (rodada de sincronização) · 727131 com hashtext(id): a trava de cada conta de agenda · 727132 lembretes
import cron from 'node-cron';
import { pool, query } from './db/pool';
import { recoverInterrupted } from './importer/operations';
import { bus } from './realtime/bus';
import { cleanupStaleConnections } from './realtime/ws';
import { runRetention } from './services/retention';
import { getSetting } from './services/settings';
import { startIntegrationsRuntime } from './integrations/runtime'; // Integrações (Jira/Teams)

// Tarefas periódicas. Cada tarefa usa um advisory lock para rodar em uma só instância.
export async function withLock(key: number, fn: () => Promise<unknown>) {
  // O advisory lock é da conexão: trava e destrava precisam usar o mesmo cliente.
  const client = await pool.connect();
  let failed: Error | undefined;
  try {
    const r = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [key]);
    if (!r.rows[0].ok) return;
    try {
      await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [key]);
    }
  } catch (e) {
    failed = e as Error;
    throw e;
  } finally {
    // Depois de um erro a conexão pode ter morrido (banco reiniciado) ou ficado com o lock: descarta em vez de devolver.
    client.release(failed);
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

  // Chamadas: toques vencidos, presença no servidor de chamadas, travas, chamadas abandonadas e histórico.
  const calls = setInterval(() => {
    void withLock(727110, async () => {
      const { sweepCalls } = await import('./calls/sweep');
      await sweepCalls();
    }).catch((e) => log(`chamadas falhou: ${e.message}`));
  }, 10_000);

  // Figurinhas: lixeira de arquivos, quarentena vencida e arquivos sem uso há 7 dias.
  const runStickersGc = () =>
    void withLock(727111, async () => {
      const { gcStickerFiles } = await import('./stickers/moderation');
      const r = await gcStickerFiles();
      if (r.stuck) log(`figurinhas: ${r.stuck} arquivo(s) não saem do disco há mais de 3 dias (veja a tabela sticker_trash)`);
    }).catch((e) => log(`limpeza de figurinhas falhou: ${e.message}`));
  tasks.push(cron.schedule('30 3 * * *', runStickersGc));
  const stickersBoot = setTimeout(runStickersGc, 60_000); // termina o que um desligamento deixou na lixeira

  // Integrações (Jira/Teams)
  tasks.push(startIntegrationsRuntime(log));

  // Agenda: sincronização com o Google/Outlook (cada conta no seu intervalo) e lembretes antes do início.
  const calendarSync = setInterval(() => {
    void withLock(727130, async () => {
      const { syncDue } = await import('./calendar/sync');
      await syncDue(log);
    }).catch((e) => log(`agenda falhou: ${e.message}`));
  }, 60_000);
  const calendarReminders = setInterval(() => {
    void withLock(727132, async () => {
      const { sendDueReminders } = await import('./calendar/reminders');
      await sendDueReminders();
    }).catch((e) => log(`lembretes da agenda falharam: ${e.message}`));
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
      else if (lexpr) ldapTask = cron.schedule(lexpr, () => void import('./ldap/ldap').then((m) => m.runScheduledLdapSync(log)).catch((e) => log(`sincronização LDAP falhou: ${e.message}`)));
    }
  };
  reschedule();
  const re = setInterval(reschedule, 60_000);

  return () => {
    clearInterval(heartbeat);
    clearInterval(calls);
    clearInterval(re);
    clearInterval(calendarSync);
    clearInterval(calendarReminders);
    clearTimeout(stickersBoot);
    for (const t of tasks) t.stop();
    retentionTask?.stop();
    ldapTask?.stop();
  };
}
