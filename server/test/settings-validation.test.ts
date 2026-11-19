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
      ['Site_Name', '   ', /^Nome do chat: Informe o nome\.$/],
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

describe('padrão e retenção', () => {
  it('a lista traz o padrão de cada configuração, menos o das senhas e das chaves geradas (admsys-30)', async () => {
    expect((await save({ Message_MaxAllowedSize: 7000 })).success).toBe(true);
    const list = (await api('GET', 'settings', undefined, A)).settings as any[];
    const by = (id: string) => list.find((s) => s._id === id);
    expect(by('Message_MaxAllowedSize')).toMatchObject({ value: 7000, packageValue: 5000 });
    expect(by('Accounts_RegistrationForm')).toHaveProperty('packageValue');
    expect(by('SMTP_Password')).not.toHaveProperty('packageValue');
    expect(by('Push_VAPID_Public_Key')).not.toHaveProperty('packageValue');
    // A lista pública (sem login) continua só com chave e valor.
    const pub = (await api('GET', 'settings.public')).settings as any[];
    expect(pub.every((s) => Object.keys(s).sort().join() === '_id,value')).toBe(true);
    // Restaurar = gravar o padrão.
    expect((await save({ Message_MaxAllowedSize: by('Message_MaxAllowedSize').packageValue })).success).toBe(true);
  });

  it('executar a limpeza com a política desligada explica em vez de dizer "0 itens removidos" (admsys-28)', async () => {
    await save({ RetentionPolicy_Enabled: false });
    expect(await api('POST', 'retention.run', {}, A)).toMatchObject({
      status: 400,
      errorType: 'error-retention-disabled',
      error: 'A política de retenção está desligada. Ligue-a e salve antes de executar a limpeza.',
    });
    await save({ RetentionPolicy_Enabled: true });
    try {
      expect(await api('POST', 'retention.run', {}, A)).toMatchObject({ success: true, removed: 0 });
    } finally {
      await save({ RetentionPolicy_Enabled: false });
    }
  });
});

describe('canais padrão', () => {
  const isDefault = async (name: string) => (await pool.query('SELECT is_default FROM rooms WHERE name = $1', [name])).rows[0].is_default as boolean;
  const setting = async () => ((await api('GET', 'settings', undefined, A)).settings as any[]).find((s) => s._id === 'Default_Channels').value;

  it('a lista vale na hora para quem entra, recusa canal que não existe e acompanha a marca de Administração › Salas', async () => {
    const op = await api('POST', 'channels.create', { name: 'operacao' }, A);
    await api('POST', 'groups.create', { name: 'privado' }, A);
    const bad = await save({ Default_Channels: 'geral,naoexiste' });
    expect(bad.status).toBe(400);
    expect(bad.error).toBe('Canais padrão (separados por vírgula): Canal não encontrado: naoexiste.');
    expect((await save({ Default_Channels: 'geral, #operacao, privado' })).success).toBe(true);
    expect([await isDefault('geral'), await isDefault('operacao'), await isDefault('privado')]).toEqual([true, true, true]);
    const u = await newUser(A);
    const rooms = (await pool.query('SELECT r.name FROM subscriptions s JOIN rooms r ON r.id = s.room_id WHERE s.user_id = $1 ORDER BY r.name', [u.userId])).rows.map((r) => r.name);
    expect(rooms).toEqual(['geral', 'operacao', 'privado']);
    // Tirar da lista desmarca a sala.
    expect((await save({ Default_Channels: 'operacao' })).success).toBe(true);
    expect([await isDefault('geral'), await isDefault('operacao'), await isDefault('privado')]).toEqual([false, true, false]);
    // Marcar em Administração › Salas, renomear e excluir regravam a configuração.
    const geral = (await api('GET', 'channels.info', { roomName: 'geral' }, A)).channel._id;
    expect((await api('POST', 'rooms.saveRoomSettings', { rid: geral, default: true }, A)).success).toBe(true);
    expect(await setting()).toBe('geral,operacao');
    expect((await api('POST', 'rooms.saveRoomSettings', { rid: op.channel._id, roomName: 'operacao-n1' }, A)).success).toBe(true);
    expect(await setting()).toBe('geral,operacao-n1');
    expect((await api('POST', 'rooms.delete', { roomId: op.channel._id }, A)).success).toBe(true);
    expect(await setting()).toBe('geral');
  });

  it('discussão marcada como padrão não quebra a sincronização e fica fora da lista', async () => {
    const geral = (await api('GET', 'channels.info', { roomName: 'geral' }, A)).channel._id;
    const d = await api('POST', 'rooms.createDiscussion', { prid: geral, t_name: 'Discussão padrão' }, A);
    const did = d.discussion._id ?? d.discussion.rid;
    // Antes: 500 (a configuração recusava o código da discussão) e a sala ficava marcada pela metade.
    expect((await api('POST', 'rooms.saveRoomSettings', { rid: did, default: true }, A)).success).toBe(true);
    expect(await setting()).toBe('geral');
    expect((await api('POST', 'rooms.saveRoomSettings', { rid: geral, topic: 'Avisos gerais' }, A)).success).toBe(true);
    // Gravar a lista não mexe na marca da discussão.
    expect((await save({ Default_Channels: 'geral,privado' })).success).toBe(true);
    expect((await pool.query('SELECT is_default FROM rooms WHERE id = $1', [did])).rows[0].is_default).toBe(true);
    expect((await save({ Default_Channels: 'geral' })).success).toBe(true);
    expect((await pool.query('SELECT is_default FROM rooms WHERE id = $1', [did])).rows[0].is_default).toBe(true);
  });

  it('no boot, a configuração passa a mostrar as salas marcadas, sem mudar nenhuma sala', async () => {
    const { syncDefaultChannelsOnBoot } = await import('../src/services/rooms');
    await api('POST', 'channels.create', { name: 'so-na-marca' }, A);
    // Instalação antiga: a marca e a configuração divergiam (a configuração só valia no primeiro boot).
    await pool.query(`UPDATE rooms SET is_default = true WHERE name = 'so-na-marca'`);
    setSettingCache('Default_Channels', 'geral,naoexiste');
    await syncDefaultChannelsOnBoot();
    expect(await setting()).toBe('geral,so-na-marca');
    expect((await pool.query(`SELECT name FROM rooms WHERE is_default AND prid IS NULL ORDER BY name`)).rows.map((r) => r.name)).toEqual(['geral', 'so-na-marca']);
  });
});
