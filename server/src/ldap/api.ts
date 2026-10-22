import type { FastifyInstance } from 'fastify';
import cron from 'node-cron';
import { cronLabel, type LdapStatus } from '@shared/ldap';
import { one } from '../db/pool';
import { badRequest, notFound } from '../lib/errors';
import { b, q, route, str } from '../api/http';
import { getSetting } from '../services/settings';
import { currentRuns, getRun, listRuns } from './runs';
import { searchDirectory, startBackgroundSync, testMapping } from './sync';

// Página LDAP / AD da administração. ldap.testConnection e ldap.syncNow continuam em api/admin.ts.
export function ldapRoutes(app: FastifyInstance) {
  route(app, 'GET', 'ldap.status', { permissions: ['view-privileged-setting'] }, async () => {
    const expression = String(getSetting<string>('LDAP_Background_Sync_Interval') ?? '').trim();
    const { running, lastRun } = await currentRuns();
    const users = await one(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE active)::int AS active,
              count(*) FILTER (WHERE NOT active AND ldap_deactivated_at IS NOT NULL)::int AS deactivated
       FROM users WHERE auth_source = 'ldap'`,
    );
    const status: LdapStatus = {
      enabled: !!getSetting('LDAP_Enable'),
      background: { enabled: !!getSetting('LDAP_Background_Sync'), expression, valid: !expression || cron.validate(expression), label: cronLabel(expression) },
      running,
      lastRun,
      users: { total: users?.total ?? 0, active: users?.active ?? 0, deactivatedBySync: users?.deactivated ?? 0 },
    };
    return status;
  });

  route(app, 'POST', 'ldap.sync.start', { permissions: ['edit-privileged-setting'] }, async (_req, _rep, ctx) => {
    if (!getSetting('LDAP_Enable')) throw badRequest('error-ldap-disabled', 'Ative o LDAP antes de sincronizar.');
    return { run: await startBackgroundSync(ctx) };
  });

  route(app, 'GET', 'ldap.sync.runs', { permissions: ['view-privileged-setting'] }, async (req) => {
    const offset = Math.max(0, Number(q(req).offset ?? 0) || 0);
    const count = Math.max(1, Math.min(50, Number(q(req).count ?? 20) || 20));
    return listRuns(offset, count);
  });

  route(app, 'GET', 'ldap.sync.run', { permissions: ['view-privileged-setting'] }, async (req) => {
    const run = await getRun(str(q(req).runId, 'runId'));
    if (!run) throw notFound('error-not-found', 'Sincronização não encontrada.');
    return { run };
  });

  route(app, 'POST', 'ldap.testMapping', { permissions: ['edit-privileged-setting'] }, async (req) => {
    const body = b(req);
    const login = str(body.login, 'login', { max: 256 }).trim();
    if (!login) throw badRequest('error-invalid-params', 'Informe o login do usuário.');
    const overrides = body.overrides && typeof body.overrides === 'object' && !Array.isArray(body.overrides) ? body.overrides : null;
    return { result: await testMapping(login, overrides) };
  });

  route(app, 'GET', 'ldap.directory.search', { permissions: ['edit-privileged-setting'] }, async (req) => {
    const kind = q(req).kind;
    if (kind !== 'group' && kind !== 'ou') throw badRequest('error-invalid-params', 'O parâmetro "kind" deve ser group ou ou.');
    return { items: await searchDirectory(kind, String(q(req).text ?? '').slice(0, 100)) };
  });
}
