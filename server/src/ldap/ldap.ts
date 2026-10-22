import type { Entry } from 'ldapts';
import type { LdapRunStatus, LdapSyncCounts } from '@shared/ldap';
import { config } from '../config';
import { ApiError } from '../lib/errors';
import { bindService, findEntries, groupsNamed, groupsOf, ldapErrorText, openClient } from './client';
import { loadLdapConfig } from './config';
import { emptyCounts, RunLog } from './runs';
import { runSync, syncEntry, type LdapSource } from './sync';

// Integração LDAP / Active Directory: login, teste de conexão e sincronização (o resto fica nos módulos ao lado).

export { upsertFromEntry, runScheduledLdapSync } from './sync';

// Tipo literal (não interface) para continuar aceito onde se espera Record<string, unknown>, como na auditoria.
export type LdapSyncResult = { [K in keyof LdapSyncCounts]: LdapSyncCounts[K] } & { runId: string | null; status: LdapRunStatus; error: string | null };

export type LdapLoginResult = { status: 'ok'; user: any } | { status: 'rejected'; reason: string } | { status: 'unavailable'; error: string };

function logLogin(text: string, e?: unknown) {
  if (config.logLevel !== 'silent') console.error(`LDAP: ${text}`, ...(e === undefined ? [] : [e]));
}

// "unavailable" só quando o servidor não pôde responder (rede, TLS, usuário de serviço): é o único caso em que
// o login pode cair na senha local. Recusa do diretório (senha errada, conta desativada, não encontrada) é "rejected".
export async function ldapLogin(login: string, password: string): Promise<LdapLoginResult> {
  if (!password) return { status: 'rejected', reason: 'senha vazia' };
  const cfg = loadLdapConfig();
  let client;
  try {
    client = openClient(cfg);
  } catch (e) {
    return { status: 'unavailable', error: ldapErrorText(e) };
  }
  try {
    let entries: Entry[];
    try {
      await bindService(client, cfg);
      entries = await findEntries(client, cfg, login);
    } catch (e) {
      logLogin(`servidor indisponível no login de "${login}": ${ldapErrorText(e)}`);
      return { status: 'unavailable', error: ldapErrorText(e) };
    }
    if (entries.length !== 1) {
      if (entries.length > 1) logLogin(`o login "${login}" corresponde a ${entries.length} entradas; login recusado.`);
      return { status: 'rejected', reason: entries.length ? 'ambíguo' : 'não encontrado' };
    }
    const entry = entries[0];
    // Valida a senha fazendo bind como o próprio usuário.
    const userClient = openClient(cfg);
    try {
      await userClient.bind(entry.dn, password);
    } catch (e: any) {
      // Código de resultado LDAP = o servidor respondeu e recusou (49: senha errada ou conta desativada).
      if (typeof e?.code === 'number') return { status: 'rejected', reason: e.code === 49 ? 'senha' : ldapErrorText(e) };
      return { status: 'unavailable', error: ldapErrorText(e) };
    } finally {
      await userClient.unbind().catch(() => {});
    }
    const log = new RunLog();
    try {
      const r = await syncEntry(
        { cfg, trigger: 'login', log, actor: { username: 'system' }, groupsOf: (e) => groupsOf(client, cfg, e), groupsNamed: (n) => groupsNamed(client, cfg, n) },
        entry,
      );
      for (const i of log.errors) logLogin(`login de "${login}": ${i.message}`);
      if (!r.user) return { status: 'rejected', reason: r.reason ?? 'conta não importada' };
      return { status: 'ok', user: r.user };
    } catch (e) {
      if (e instanceof ApiError && e.errorType === 'error-ldap-username-taken') throw e;
      logLogin(`falha ao sincronizar "${login}" no login`, e);
      return { status: 'rejected', reason: String((e as Error)?.message ?? e) };
    }
  } finally {
    await client.unbind().catch(() => {});
  }
}

export async function ldapTestConnection(): Promise<{ ok: true; sample: number }> {
  const cfg = loadLdapConfig();
  const client = openClient(cfg);
  try {
    await bindService(client, cfg);
    // Só a primeira página: o Samba ignora sizeLimit e devolveria o diretório inteiro.
    let sample = 0;
    const pages = client.searchPaginated(cfg.baseDn, {
      scope: 'sub',
      filter: cfg.userFilter.startsWith('(') ? cfg.userFilter : `(${cfg.userFilter})`,
      attributes: ['objectClass'],
      paged: { pageSize: 5 },
    });
    for await (const page of pages) {
      sample = page.searchEntries.length;
      break;
    }
    return { ok: true, sample };
  } catch (e) {
    throw new Error(ldapErrorText(e));
  } finally {
    await client.unbind().catch(() => {});
  }
}

// Desligado: zeros e nenhuma execução registrada (como antes). Ocupado: ApiError 409.
export async function ldapSync(
  opts: { trigger?: 'cron' | 'manual' | 'api'; startedBy?: string; source?: LdapSource } = {},
): Promise<LdapSyncResult> {
  const cfg = loadLdapConfig();
  if (!cfg.enabled) return { ...emptyCounts(), runId: null, status: 'success', error: null };
  const run = await runSync({ trigger: opts.trigger ?? 'api', startedBy: opts.startedBy ?? null, source: opts.source, cfg });
  return { ...run.counts, runId: run._id, status: run.status, error: run.error };
}
