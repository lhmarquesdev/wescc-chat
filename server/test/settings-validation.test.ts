import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { setSettingCache } from '../src/services/settings';
import { admin, api, login, newUser, startServer, stopServer, type Auth } from './helpers';

// Configurações com faixa e formato: um campo vazio (que a tela mandava como 0), um negativo ou um valor absurdo
// travava mensagens, senhas, logins e webhooks (admsys-2, admsys-4, admsys-6, admsys-7).
let A: Auth;
const save = (settings: Record<string, unknown>) => api('POST', 'settings', { settings }, A);

beforeAll(async () => {
  await startServer();
  A = await admin();
  await save({ API_Enable_Rate_Limiter: false });
});
afterAll(() => stopServer());

describe('validação das configurações', () => {
  it('números fora da faixa, vazios, decimais ou texto são recusados com o nome do campo', async () => {
    const bad: Record<string, unknown[]> = {
      Message_MaxAllowedSize: [0, -5, ''],
      Accounts_Password_Policy_MinLength: [0, 1000],
      Accounts_LoginExpiration: [0, -1],
      Integrations_Outgoing_Timeout: [0, -1],
      SMTP_Port: [0, 70000, 'abc'],
      Import_Pending_Files_Concurrency: [0],
      RetentionPolicy_TTL_Channels: [0, -10],
      Accounts_Default_Away_Minutes: [0],
      LDAP_Sync_Max_Deactivation_Percent: [500],
      FileUpload_MaxFileSize: [-1, 'x'],
      Import_MaxFileSize: [-1],
      Layout_Sidebar_Logo_Size: [30.5],
    };
    const before = (await pool.query('SELECT count(*)::int AS n FROM settings')).rows[0].n;
    for (const [id, values] of Object.entries(bad)) {
      for (const v of values) {
        const r = await save({ [id]: v });
        expect(r.status, `${id}=${JSON.stringify(v)}`).toBe(400);
        expect(r.errorType).toBe('error-invalid-setting-value');
        expect(r.error).not.toMatch(/invalid-int|invalid-option/);
      }
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM settings')).rows[0].n).toBe(before);
    expect((await save({ SMTP_Port: 'abc' })).error).toBe('Porta: use um número inteiro.');
    expect((await save({ SMTP_Port: 70000 })).error).toBe('Porta: Use um número inteiro entre 1 e 65535.');
    expect((await save({ Accounts_RegistrationForm: 'Bogus' })).error).toBe('Formulário de cadastro: opção inválida.');
    // Os limites e o "0 = sem limite" dos tamanhos continuam valendo.
    const good = await save({ Message_MaxAllowedSize: 8000, SMTP_Port: '2525', FileUpload_MaxFileSize: 0, Import_MaxFileSize: 0, Accounts_Block_Failed_Login_Attempts: 0, Message_MaxAll: 0 });
    expect(good.success).toBe(true);
    const list = (await api('GET', 'settings', undefined, A)).settings as any[];
    expect(list.find((s) => s._id === 'SMTP_Port').value).toBe(2525);
  });

  it('validade do login negativa é recusada, e um valor antigo inválido não vence o login na hora', async () => {
    expect((await save({ Accounts_LoginExpiration: -1 })).status).toBe(400);
    const u = await newUser(A);
    await pool.query(`INSERT INTO settings (id, value) VALUES ('Accounts_LoginExpiration', '-1') ON CONFLICT (id) DO UPDATE SET value = '-1'`);
    setSettingCache('Accounts_LoginExpiration', -1);
    try {
      const again = await login(u.username, 'senha-forte-1');
      expect((await api('GET', 'me', undefined, again)).success).toBe(true);
      const s = (await pool.query(`SELECT expires_at > now() + interval '23 hours' AS ok FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [u.userId])).rows[0];
      expect(s.ok).toBe(true);
    } finally {
      expect((await save({ Accounts_LoginExpiration: 90 })).success).toBe(true);
    }
  });

  it('URL do site, remetente, nome, LDAP e CORS precisam ter um formato válido', async () => {
    const cases: [string, unknown, RegExp][] = [
      ['Site_Url', 'javascript:alert(1)', /^URL do site: /],
      ['Site_Url', 'site sem http', /^URL do site: /],
      ['From_Email', 'nao-e-email', /^Remetente: /],
      ['From_Email', '', /^Remetente: /],
      ['Site_Name', '   ', /^Nome do workspace: Informe o nome\.$/],
      ['LDAP_Url', 'http://x', /^URL do servidor \(ldap:\/\/ ou ldaps:\/\/\): /],
      ['API_CORS_Origin', 'abc', /Origem inválida: abc/],
      ['API_CORS_Origin', 'https://intranet.empresa.com.br/caminho', /Origem inválida/],
    ];
    for (const [id, v, msg] of cases) {
      const r = await save({ [id]: v });
      expect(r.status, `${id}=${JSON.stringify(v)}`).toBe(400);
      expect(r.error).toMatch(msg);
    }
    const ok = await save({
      Site_Url: 'https://chat.empresa.com.br',
      From_Email: 'Chat da Empresa <chat@empresa.com.br>',
      Site_Name: 'Empresa QA',
      LDAP_Url: 'ldaps://ad.empresa.local:636',
      API_CORS_Origin: '*, https://intranet.empresa.com.br/',
    });
    expect(ok.success).toBe(true);
    expect((await save({ From_Email: 'chat@localhost', LDAP_Url: '' })).success).toBe(true);
  });
});
