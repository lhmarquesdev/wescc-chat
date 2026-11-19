import { randomInt } from 'node:crypto';
import { normalizeHighlights } from '@shared/highlights';
import type { LogoutReason, UserPreferences, UserStatus } from '@shared/index';
import { LANG_RE, normalizeLang } from '@shared/translate';
import { clampStatusText } from '@shared/status';
import { many, one, query, tx, type Queryable } from '../db/pool';
import { ApiError, badRequest, forbidden, notFound, unauthorized } from '../lib/errors';
import { newId, randomToken, sha256 } from '../lib/ids';
import { hashPassword, verifyPassword } from '../lib/password';
import { generateSecret, otpauthUrl, totpStep } from '../lib/totp';
import { bus } from '../realtime/bus';
import { audit, type Actor } from './audit';
import { announceNewDevice, deviceCookieHeader, isKnownDevice, rememberLoginDevice } from './loginDevices';
import { mapUser, presenceEvent } from './mappers';
import { getSetting } from './settings';
import { recordActivity } from './stats';

export interface Ctx {
  userId: string;
  username: string;
  sessionId: string;
  ip?: string;
  // Troca de senha ou configuração de 2FA pendente: a API só aceita as rotas para resolver isso.
  setup?: 'password' | '2fa' | null;
}

export const actorOf = (c: Ctx): Actor => ({ id: c.userId, username: c.username, ip: c.ip });

const USERNAME_RE = /^[0-9a-zA-Z._-]{2,40}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*$/;
// @all e @here avisam a sala inteira, e "system" assina os avisos do próprio chat: nenhuma conta usa esses nomes, em
// maiúsculas ou minúsculas (cadastro, administração, importação, LDAP, SAML e OAuth).
export const RESERVED_USERNAMES = new Set(['all', 'here', 'system']);
export const isReservedUsername = (username: string) => RESERVED_USERNAMES.has(username.toLowerCase());

export function validateUsername(username: string) {
  if (!USERNAME_RE.test(username)) throw badRequest('error-invalid-username', 'Nome de usuário inválido (2-40 caracteres: letras, números, ponto, hífen, sublinhado).');
  if (isReservedUsername(username)) throw badRequest('error-invalid-username', 'Este nome de usuário é reservado. Escolha outro.');
}

// Nome de exibição: espaços juntados, sem caracteres invisíveis (espaço de largura zero, controles de direção do
// texto, caracteres de controle, o "preenchimento" coreano que conta como letra) e com alguma letra ou número; senão a
// pessoa aparece sem nome nas listas e nas mensagens.
export const NAME_MAX = 100;
export const BIO_MAX = 500;
const INVISIBLE_RE = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u00AD\u115F\u1160\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFEFF\uFFA0]/g;

export function normalizeName(v: unknown) {
  if (v !== undefined && v !== null && typeof v !== 'string') throw badRequest('error-invalid-name', 'O nome deve ser um texto.');
  const name = String(v ?? '').normalize('NFC').replace(INVISIBLE_RE, '').replace(/\s+/g, ' ').trim();
  if (!/[\p{L}\p{N}]/u.test(name)) throw badRequest('error-invalid-name', 'Informe um nome com letras ou números.');
  if (name.length > NAME_MAX) throw badRequest('error-invalid-name', `O nome pode ter no máximo ${NAME_MAX} caracteres.`);
  return name;
}

function normalizeBio(v: string) {
  const bio = v.normalize('NFC').replace(INVISIBLE_RE, '').trim();
  if (bio.length > BIO_MAX) throw badRequest('error-invalid-bio', `O campo Sobre pode ter no máximo ${BIO_MAX} caracteres.`);
  return bio;
}

// Domínios de e-mail permitidos (Accounts_AllowedDomainsList): no cadastro e quando a pessoa troca o próprio e-mail.
function assertAllowedDomain(email: string) {
  const domains = String(getSetting('Accounts_AllowedDomainsList') ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  if (domains.length && !domains.includes(email.split('@')[1]?.toLowerCase())) throw badRequest('error-invalid-domain', 'Domínio de e-mail não permitido.');
}

export function validatePassword(password: string) {
  if (password && !password.trim()) throw badRequest('error-password-policy-not-met', 'A senha não pode ser só espaços.');
  const min = getSetting<number>('Accounts_Password_Policy_MinLength');
  const errs: string[] = [];
  if (password.length < min) errs.push(`mínimo de ${min} caracteres`);
  if (getSetting('Accounts_Password_Policy_AtLeastOneUppercase') && !/[A-Z]/.test(password)) errs.push('uma letra maiúscula');
  if (getSetting('Accounts_Password_Policy_AtLeastOneNumber') && !/[0-9]/.test(password)) errs.push('um número');
  if (getSetting('Accounts_Password_Policy_AtLeastOneSpecialCharacter') && !/[^A-Za-z0-9]/.test(password)) errs.push('um caractere especial');
  if (errs.length) throw badRequest('error-password-policy-not-met', `A senha precisa de: ${errs.join(', ')}.`);
}

// Confirmações (gerar token, desligar o 2FA) pedem a senha só de quem entra com a senha do chat, como a tela mostra:
// a conta local vinculada depois ao AD ou ao SAML guarda a senha antiga, que a pessoa já não usa.
const asksPassword = (u: any) => !!u.password_hash && (u.auth_source ?? 'local') === 'local';

export async function getUserById(id: string) {
  return one('SELECT * FROM users WHERE id = $1', [id]);
}

export async function getUserByUsername(username: string) {
  return one('SELECT * FROM users WHERE lower(username) = lower($1)', [username]);
}

export async function findUserForLogin(login: string) {
  return one('SELECT * FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($1) LIMIT 1', [login]);
}

export interface CreateUserInput {
  username: string;
  name?: string;
  email?: string | null;
  password?: string | null;
  roles?: string[];
  active?: boolean;
  verified?: boolean;
  type?: 'user' | 'bot' | 'app';
  authSource?: 'local' | 'ldap' | 'saml' | 'oauth';
  externalId?: string | null;
  requirePasswordChange?: boolean;
  joinDefaultChannels?: boolean;
  skipPasswordPolicy?: boolean;
}

// E-mail vazio (o campo opcional da tela) é "sem e-mail": grava NULL, senão o segundo cadastro sem e-mail esbarra no
// índice único de lower(email).
export const normalizeEmail = (email: unknown) => (typeof email === 'string' ? email.trim() : '') || null;

const emailTaken = () => badRequest('error-field-unavailable', 'Este e-mail já está em uso.');
const isEmailConflict = (e: any) => e?.code === '23505' && e?.constraint === 'users_email_uq';

export async function createUser(input: CreateUserInput, actor?: Actor) {
  validateUsername(input.username);
  const email = normalizeEmail(input.email);
  if (email && !EMAIL_RE.test(email)) throw badRequest('error-invalid-email', 'E-mail inválido.');
  if (input.password && !input.skipPasswordPolicy) validatePassword(input.password);
  if (await getUserByUsername(input.username)) throw badRequest('error-field-unavailable', `O nome de usuário ${input.username} já está em uso.`);
  if (email && (await one('SELECT 1 FROM users WHERE lower(email) = lower($1)', [email]))) throw emailTaken();
  const id = newId();
  const hash = input.password ? await hashPassword(input.password) : null;
  const row = await one(
    `INSERT INTO users (id, username, name, email, email_verified, password_hash, active, type, roles, auth_source, external_id, require_password_change)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [
      id,
      input.username,
      input.name ?? input.username,
      email,
      input.verified ?? false,
      hash,
      input.active ?? true,
      input.type ?? 'user',
      input.roles?.length ? input.roles : ['user'],
      input.authSource ?? 'local',
      input.externalId ?? null,
      input.requirePasswordChange ?? false,
    ],
  ).catch((e) => {
    // Dois cadastros com o mesmo e-mail ao mesmo tempo: a mesma mensagem da conferência acima.
    throw isEmailConflict(e) ? emailTaken() : e;
  });
  if (input.joinDefaultChannels !== false) {
    const { joinDefaultChannels } = await import('./rooms');
    await joinDefaultChannels(id);
  }
  if (actor) await audit(actor, 'user.created', { userId: id, username: input.username }, { roles: row.roles });
  const { emit } = await import('./hooks');
  emit('user.created', { user: { _id: id, username: row.username, name: row.name, email: row.email } });
  return row;
}

export async function registerUser(input: { username: string; name: string; email: string; pass: string; secretURL?: string }, ip?: string) {
  const mode = getSetting<string>('Accounts_RegistrationForm');
  if (mode === 'Disabled') throw forbidden('O cadastro está desativado.');
  if (mode === 'Secret' && (!input.secretURL || input.secretURL !== getSetting('Accounts_RegistrationForm_SecretURL')))
    throw forbidden('Cadastro permitido somente pelo link secreto.');
  // Mensagens para quem preenche a tela de cadastro (não o nome do parâmetro da API).
  const username = input.username.trim();
  const email = input.email.trim();
  if (!username) throw badRequest('error-invalid-params', 'Informe o nome de usuário.');
  const name = normalizeName(input.name);
  if (!email) throw badRequest('error-invalid-params', 'Informe o e-mail.');
  if (!input.pass) throw badRequest('error-invalid-params', 'Informe a senha.');
  assertAllowedDomain(email);
  const manual = getSetting<boolean>('Accounts_ManuallyApproveNewUsers');
  const row = await createUser({ username, name, email, password: input.pass, active: !manual });
  // Aprovação manual: a administração vê a conta como "Aguardando aprovação" (não como uma conta desativada).
  if (manual) await query('UPDATE users SET pending_approval = true WHERE id = $1', [row.id]);
  await audit({ id: row.id, username: row.username, ip }, 'user.registered', { userId: row.id });
  if (manual) void notifyPendingApproval(row).catch(() => {});
  return row;
}

// Cadastro aguardando aprovação: quem pode aprovar (ativar contas) fica sabendo na hora, no chat e por e-mail, com o
// link para o filtro "Aguardando aprovação" de Administração › Usuários.
async function notifyPendingApproval(u: { id: string; username: string; name: string; email: string | null }) {
  const { rolesWithPermission } = await import('./permissions');
  const roles = rolesWithPermission('edit-other-user-active-status');
  if (!roles.length) return;
  const people = await many<{ id: string; email: string | null }>(`SELECT id, email FROM users WHERE active AND type = 'user' AND roles && $1::text[]`, [roles]);
  if (!people.length) return;
  const who = `${u.name || u.username} (@${u.username}${u.email ? `, ${u.email}` : ''})`;
  bus.publish(
    { users: people.map((p) => p.id) },
    { type: 'notification', rid: '', title: 'Cadastro aguardando aprovação', text: `${who} se cadastrou e aguarda aprovação em Administração › Usuários.`, messageId: '', sender: { _id: 'system', username: 'system' } },
  );
  const { sendMail } = await import('./mailer');
  const { siteUrl } = await import('./sso');
  const site = getSetting<string>('Site_Name');
  for (const p of people) {
    if (!p.email) continue;
    await sendMail({
      to: p.email,
      subject: `[${site}] Cadastro aguardando aprovação`,
      text: `Olá.\n\n${who} se cadastrou no ${site} e aguarda a aprovação de um administrador para entrar.\n\nPara aprovar ou recusar o cadastro, abra:\n${siteUrl()}/admin/users?status=pending`,
    });
  }
}

// ---------- Login e sessões ----------

// ---------- Bloqueio por tentativas falhas (no banco, vale para todas as instâncias) ----------

// O contador do login usa o id da conta quando ela existe (usuário e e-mail contam juntos).
const loginKey = (login: string) => `user:${login.trim().toLowerCase()}`;

// knownDevice: o navegador já entrou nesta conta (cookie wescc_device; vem de isKnownDevice). Ele conta as próprias falhas
// à parte e não é barrado pelos contadores da conta e do IP: senão qualquer um tiraria um colega do chat errando a senha
// dele de outra máquina (ou da mesma rede), a cada fim de bloqueio. Os outros aparelhos seguem o bloqueio da conta.
function attemptKeys(login: string, ip?: string, knownDevice?: string | null) {
  const keys: { key: string; max: number }[] = [];
  const byUser = getSetting<number>('Accounts_Block_Failed_Login_Attempts');
  const byIp = getSetting<number>('Accounts_Block_Failed_Login_Attempts_By_Ip');
  if (knownDevice) {
    if (byUser > 0) keys.push({ key: `${loginKey(login)}|dev:${knownDevice}`, max: byUser });
    return keys;
  }
  if (byUser > 0) keys.push({ key: loginKey(login), max: byUser });
  if (byIp > 0 && ip) keys.push({ key: `ip:${ip}`, max: byIp });
  return keys;
}

const blockMinutes = () => Math.max(1, getSetting<number>('Accounts_Block_Failed_Login_Minutes') || 5);

async function assertNotBlocked(login: string, ip?: string, knownDevice?: string | null) {
  const keys = attemptKeys(login, ip, knownDevice).map((k) => k.key);
  if (!keys.length) return;
  const rows = await many('SELECT key FROM login_attempts WHERE key = ANY($1) AND blocked_until > now()', [keys]);
  if (!rows.length) return;
  // A conta bloqueada (e não o IP) num aparelho em que ela nunca entrou: quem é dono dela entra por outro.
  if (!knownDevice && rows.every((r) => r.key === loginKey(login)))
    throw new ApiError(429, 'error-login-blocked', 'Muitas tentativas falhas nesta conta. Entre por um computador ou celular em que você já entrou antes, ou tente novamente em alguns minutos.');
  throw new ApiError(429, 'error-login-blocked', 'Muitas tentativas falhas. Tente novamente em alguns minutos.');
}

async function countFailure(key: string, max: number) {
  const minutes = blockMinutes();
  // A contagem recomeça depois de um período sem falhas.
  await query(
    `INSERT INTO login_attempts (key, count, updated_at) VALUES ($1, 1, now())
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN login_attempts.updated_at < now() - make_interval(mins => $2) THEN 1 ELSE login_attempts.count + 1 END,
       updated_at = now()`,
    [key, minutes],
  );
  await query(`UPDATE login_attempts SET blocked_until = now() + make_interval(mins => $3), count = 0 WHERE key = $1 AND count >= $2`, [key, max, minutes]);
}

async function recordFailedAttempt(login: string, ip?: string, knownDevice?: string | null) {
  for (const { key, max } of attemptKeys(login, ip, knownDevice)) await countFailure(key, max);
}

async function clearFailedAttempts(login: string, knownDevice?: string | null) {
  // Só zera o contador deste login (o do aparelho conhecido, que não desfaz um bloqueio da conta em andamento para os
  // outros): o do IP continua (senão bastaria entrar numa conta própria entre as tentativas).
  await query('DELETE FROM login_attempts WHERE key = $1', [knownDevice ? `${loginKey(login)}|dev:${knownDevice}` : loginKey(login)]);
}

export interface DeviceInfo {
  userAgent?: string;
  ip?: string;
  name?: string;
  deviceId?: string; // cookie wescc_device do navegador (e-mail de login em dispositivo novo)
}

function parseDevice(d: DeviceInfo) {
  const ua = d.userAgent ?? '';
  // iPhone e iPad dizem "like Mac OS X", e o Android diz "Linux": os celulares vêm antes. No iPhone, Chrome, Firefox e
  // Edge se chamam CriOS, FxiOS e EdgiOS (e o Edge do Android, EdgA).
  const os = /Windows/i.test(ua) ? 'Windows' : /iPhone|iPad|iPod/i.test(ua) ? 'iOS' : /Android/i.test(ua) ? 'Android' : /Mac OS X/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : 'Desconhecido';
  const browser = /Edg(e|A|iOS)?\//.test(ua) ? 'Edge' : /Chrome\/|CriOS\//.test(ua) ? 'Chrome' : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : ua ? 'Outro' : 'API';
  return { userAgent: ua, ip: d.ip, os, browser, name: d.name ?? `${browser} em ${os}` };
}

// Todo login (senha, LDAP, SAML, OAuth) passa por aqui: o dispositivo fica anotado e, se for novo numa conta que já
// tinha outro, a sessão sai marcada e o e-mail vai em segundo plano. deviceCookie: o Set-Cookie do wescc_device.
export async function createSession(userId: string, device: DeviceInfo) {
  const token = randomToken();
  const id = newId();
  const days = Math.max(1, Number(getSetting('Accounts_LoginExpiration')) || 90); // 0 ou negativo vencia o login na hora
  const parsed = parseDevice(device);
  const seen = await rememberLoginDevice(userId, device, parsed);
  await query(
    `INSERT INTO sessions (id, user_id, token_hash, device, expires_at) VALUES ($1,$2,$3,$4, now() + ($5 || ' days')::interval)`,
    [id, userId, sha256(token), JSON.stringify(seen.isNew ? { ...parsed, newDevice: true } : parsed), String(days)],
  );
  await query('UPDATE users SET last_login = now() WHERE id = $1', [userId]);
  void recordActivity(userId, 'session');
  if (seen.isNew) void announceNewDevice(userId, parsed, device.ip, id).catch(() => {});
  return { sessionId: id, authToken: token, deviceCookie: deviceCookieHeader(seen.deviceId) };
}

export class TwoFactorRequired extends Error {
  constructor(public method: 'totp') {
    super('totp-required');
  }
}

// Conta que não existe (ou sem senha local) também calcula um scrypt, com este hash de mentira: senão o tempo de
// resposta diria quem tem cadastro.
let dummyHash: Promise<string> | null = null;

export async function login(params: { user: string; password: string; code?: string; device: DeviceInfo }) {
  const dummy = (dummyHash ??= hashPassword(randomToken()));
  let user = await findUserForLogin(params.user);
  const attemptLogin = user ? `id:${user.id}` : params.user;
  const known = await isKnownDevice(user?.id, params.device.deviceId);
  await assertNotBlocked(attemptLogin, params.device.ip, known);
  let ok = false;
  if (getSetting('LDAP_Enable') && (!user || user.auth_source === 'ldap')) {
    const { ldapLogin } = await import('../ldap/ldap');
    const r = await ldapLogin(params.user, params.password); // só lança o conflito de conta (409)
    if (r.status === 'ok') {
      user = r.user;
      ok = true;
    } else if (r.status === 'unavailable' && user?.password_hash && getSetting('LDAP_Login_Fallback')) {
      // Servidor fora do ar: vale a senha local. Recusa do diretório (senha errada, conta desativada) não cai aqui.
      ok = await verifyPassword(params.password, user.password_hash);
    } else if (r.status === 'unavailable') {
      // Sem a senha local para conferir (opção desligada, ou conta do AD sem senha no chat, o caso comum): a senha pode
      // estar certa, então não conta como tentativa falha.
      throw new ApiError(503, 'error-ldap-unavailable', 'O servidor de rede (AD) não respondeu. Tente de novo em alguns minutos.');
    }
  } else {
    ok = (await verifyPassword(params.password, user?.password_hash || (await dummy))) && !!user?.password_hash;
  }
  if (!ok) user = null;

  if (!user) {
    await recordFailedAttempt(attemptLogin, params.device.ip, known);
    await audit({ ip: params.device.ip, username: params.user }, 'auth.login.failed', { login: params.user });
    throw unauthorized('Usuário ou senha incorretos.');
  }
  if (!user.active) throw unauthorized('Usuário desativado ou aguardando aprovação.');
  if (user.totp_enabled && getSetting('Accounts_TwoFactorAuthentication_Enabled')) {
    if (!params.code) throw new TwoFactorRequired('totp');
    if (!(await check2fa(user, params.code))) {
      // Código errado conta como tentativa falha (senão o código de 6 dígitos poderia ser adivinhado).
      await recordFailedAttempt(attemptLogin, params.device.ip, known);
      await audit({ id: user.id, username: user.username, ip: params.device.ip }, 'auth.login.failed', { login: params.user, reason: 'totp' });
      throw unauthorized('Código de verificação inválido ou já usado.');
    }
  }
  await clearFailedAttempts(attemptLogin, known);
  const s = await createSession(user.id, params.device);
  await audit({ id: user.id, username: user.username, ip: params.device.ip }, 'auth.login', { sessionId: s.sessionId });
  return { user, ...s };
}

// Código de backup como a pessoa digita: sem diferença de maiúsculas, espaços ou hífen.
const normalizeBackupCode = (code: string) => code.toUpperCase().replace(/[\s-]/g, '');

// 10 caracteres sem os que se confundem (0/O, 1/I/L), mostrados como XXXXX-XXXXX.
const BACKUP_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function newBackupCode() {
  let s = '';
  for (let i = 0; i < 10; i++) s += BACKUP_ALPHABET[randomInt(BACKUP_ALPHABET.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

export async function check2fa(user: any, code: string) {
  // Cada código do aplicativo vale uma vez (o mesmo código visto ou capturado não abre outro login): o UPDATE só passa
  // com um passo depois do último aceito, também quando dois pedidos chegam juntos.
  const step = user.totp_secret ? totpStep(user.totp_secret, code) : null;
  if (step !== null) {
    return !!(await one('UPDATE users SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING id', [user.id, step]));
  }
  // Códigos de backup de antes da 046 (base64, com maiúsculas e minúsculas) valem como foram mostrados.
  for (const hashed of [sha256(normalizeBackupCode(code)), sha256(code.trim())]) {
    if (user.backup_codes.includes(hashed)) {
      return !!(await one('UPDATE users SET backup_codes = array_remove(backup_codes, $2) WHERE id = $1 AND $2 = ANY(backup_codes) RETURNING id', [user.id, hashed]));
    }
  }
  return false;
}

const touchCache = new Map<string, number>();

export async function resolveToken(userId: string | undefined, token: string) {
  const row = await one(
    `SELECT s.id AS session_id, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [sha256(token)],
  );
  if (row) {
    if ((userId && row.id !== userId) || new Date(row.expires_at).getTime() < Date.now() || !row.active) return null;
    const last = touchCache.get(row.session_id) ?? 0;
    if (Date.now() - last > 60_000) {
      touchCache.set(row.session_id, Date.now());
      void query('UPDATE sessions SET last_active_at = now() WHERE id = $1', [row.session_id]);
    }
    return { user: row, sessionId: row.session_id as string };
  }
  // Tokens de acesso pessoal
  const pat = await one(
    `SELECT p.id AS pat_id, u.* FROM personal_access_tokens p JOIN users u ON u.id = p.user_id WHERE p.token_hash = $1`,
    [sha256(token)],
  );
  if (pat && (!userId || pat.id === userId) && pat.active) {
    void query('UPDATE personal_access_tokens SET last_used_at = now() WHERE id = $1', [pat.pat_id]);
    return { user: pat, sessionId: `pat:${pat.pat_id}` };
  }
  return null;
}

export async function logout(sessionId: string, reason?: LogoutReason) {
  await query('DELETE FROM sessions WHERE id = $1', [sessionId]);
  bus.forceLogout({ sessionIds: [sessionId], reason });
}

export async function listSessions(opts: { userId?: string; offset?: number; count?: number; search?: string }) {
  const params: unknown[] = [];
  const where: string[] = ['s.expires_at > now()'];
  if (opts.userId) where.push(`s.user_id = $${params.push(opts.userId)}`);
  if (opts.search) where.push(`(u.username ILIKE $${params.push(`%${opts.search}%`)} OR s.device->>'ip' ILIKE $${params.length})`);
  const rows = await many(
    `SELECT s.*, u.username, u.name, u.roles, count(*) OVER() AS total FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE ${where.join(' AND ')} ORDER BY s.last_active_at DESC LIMIT ${Math.min(opts.count ?? 50, 200)} OFFSET ${Number(opts.offset ?? 0)}`,
    params,
  );
  return {
    total: Number(rows[0]?.total ?? 0),
    sessions: rows.map((r) => ({
      _id: r.id,
      userId: r.user_id,
      username: r.username,
      name: r.name, // a tabela de dispositivos mostra nome e @usuário, como as outras
      roles: r.roles, // o cadeado da administração (dono com papel acima de quem vê)
      device: r.device,
      createdAt: r.created_at,
      lastActiveAt: r.last_active_at,
    })),
  };
}

export async function revokeSession(ctx: Ctx, sessionId: string, asAdmin: boolean) {
  const s = await one('SELECT * FROM sessions WHERE id = $1', [sessionId]);
  if (!s) throw notFound('error-session-not-found', 'Sessão não encontrada.');
  if (s.user_id !== ctx.userId && !asAdmin) throw forbidden();
  // A tela de entrar do aparelho que saiu explica quem encerrou (a própria sessão atual sai sem aviso, como no Sair).
  await logout(sessionId, s.user_id !== ctx.userId ? 'admin-logout' : sessionId !== ctx.sessionId ? 'session-revoked' : undefined);
  await audit(actorOf(ctx), 'session.revoked', { sessionId, userId: s.user_id });
}

// reason: o motivo que a tela de entrar mostra a quem saiu.
export async function revokeAllSessions(userId: string, exceptSessionId?: string, reason?: LogoutReason) {
  const rows = await many('DELETE FROM sessions WHERE user_id = $1 AND id <> $2 RETURNING id', [userId, exceptSessionId ?? '']);
  if (rows.length) bus.forceLogout({ sessionIds: rows.map((r) => r.id), reason });
  return rows.length;
}

// Tokens de acesso pessoal saem junto quando a conta é retomada (senha redefinida, senha trocada ou sessões
// encerradas pelo administrador): senão quem invadiu continuaria na API. Os sockets abertos com eles fecham.
export async function revokePersonalTokens(userId: string) {
  const rows = await many('DELETE FROM personal_access_tokens WHERE user_id = $1 RETURNING id', [userId]);
  if (rows.length) bus.forceLogout({ sessionIds: rows.map((r) => `pat:${r.id}`) });
  return rows.length;
}

// ---------- Redefinição de senha por e-mail ----------

const RESET_TTL_MIN = 60;

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Só contas que entram com senha do próprio chat (LDAP e contas só de SAML/OAuth seguem o provedor).
const canResetPassword = (u: any) => u.active && u.type !== 'bot' && (u.auth_source === 'local' || (u.auth_source !== 'ldap' && !!u.password_hash));

// Sempre responde do mesmo jeito, exista ou não a conta, para não revelar quem tem cadastro.
export async function requestPasswordReset(email: string, ip?: string) {
  if (!getSetting('Accounts_PasswordReset')) throw forbidden('A redefinição de senha está desativada.');
  // Sem SMTP o link nunca chegaria (o envio devolve false em silêncio): a pessoa fica sabendo na hora.
  if (!getSetting('SMTP_Host')) throw new ApiError(503, 'error-email-not-configured', 'O envio de e-mails não está configurado neste chat. Peça ao administrador para redefinir a sua senha.');
  const u = await one('SELECT * FROM users WHERE lower(email) = lower($1)', [email.trim()]);
  if (!u || !canResetPassword(u)) return;
  // Um pedido a cada 2 minutos por conta; só o link mais recente vale.
  if (await one(`SELECT 1 FROM password_resets WHERE user_id = $1 AND created_at > now() - interval '2 minutes'`, [u.id])) return;
  const token = randomToken();
  await query('DELETE FROM password_resets WHERE user_id = $1', [u.id]);
  await query(`INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))`, [sha256(token), u.id, RESET_TTL_MIN]);
  const { siteUrl } = await import('./sso');
  const { sendMail } = await import('./mailer');
  const site = getSetting<string>('Site_Name');
  // O token vai no fragmento (#): não chega ao servidor nem aos logs de acesso.
  const link = `${siteUrl()}/reset-password#token=${token}`;
  const text = `Olá, ${u.name || u.username}.\n\nRecebemos um pedido para redefinir a sua senha no ${site}. Para criar uma senha nova, abra o link abaixo em até ${RESET_TTL_MIN} minutos:\n\n${link}\n\nSe não foi você, ignore este e-mail: a senha atual continua valendo.`;
  const html = `<p>Olá, ${escapeHtml(u.name || u.username)}.</p><p>Recebemos um pedido para redefinir a sua senha no ${escapeHtml(site)}. Para criar uma senha nova, clique no botão abaixo em até ${RESET_TTL_MIN} minutos:</p><p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;background:#1d74f5;color:#fff;border-radius:6px;text-decoration:none">Redefinir senha</a></p><p style="color:#6c727a">Se não foi você, ignore este e-mail: a senha atual continua valendo.</p>`;
  // Envio em segundo plano, para o tempo de resposta não indicar se a conta existe.
  void sendMail({ to: u.email, subject: `[${site}] Redefinição de senha`, text, html });
  await audit({ id: u.id, username: u.username, ip }, 'user.password.reset.requested', { userId: u.id });
}

// Contas criadas pela importação: o mesmo link de "Esqueci minha senha", mas sem o limite de um pedido a cada
// 2 minutos e com prazo maior, porque a pessoa pode demorar a ver o convite.
const SETUP_TTL_MIN = 3 * 24 * 60;

// Também na criação pela administração ("Enviar link para definir a senha") e no editor (reason 'admin': o
// administrador pediu uma senha nova; a atual continua valendo até a pessoa trocar).
export async function sendPasswordSetupEmail(userId: string, reason: 'created' | 'admin' = 'created') {
  // O link usa a tela de redefinição, que não funciona com ela desativada.
  if (!getSetting('Accounts_PasswordReset')) return false;
  const u = await getUserById(userId);
  if (!u?.email || !canResetPassword(u)) return false;
  const token = randomToken();
  await query('DELETE FROM password_resets WHERE user_id = $1', [u.id]);
  await query(`INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))`, [sha256(token), u.id, SETUP_TTL_MIN]);
  const { siteUrl } = await import('./sso');
  const { sendMail } = await import('./mailer');
  const site = getSetting<string>('Site_Name');
  const link = `${siteUrl()}/reset-password#token=${token}`;
  const intro = (s: string, user: string) =>
    reason === 'admin' ? `Um administrador do ${s} pediu que você defina uma senha nova para a conta ${user}.` : `Sua conta no ${s} foi criada com o nome de usuário ${user}.`;
  const text = `Olá, ${u.name || u.username}.\n\n${intro(site, `"${u.username}"`)} Para definir a sua senha, abra o link abaixo em até 3 dias:\n\n${link}\n\nDepois desse prazo, use "Esqueci minha senha" na tela de login.`;
  const html = `<p>Olá, ${escapeHtml(u.name || u.username)}.</p><p>${intro(escapeHtml(site), `<b>${escapeHtml(u.username)}</b>`)} Para definir a sua senha, clique no botão abaixo em até 3 dias:</p><p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;background:#1d74f5;color:#fff;border-radius:6px;text-decoration:none">Definir senha</a></p><p style="color:#6c727a">Depois desse prazo, use "Esqueci minha senha" na tela de login.</p>`;
  return sendMail({ to: u.email, subject: `Defina sua senha no ${site}`, text, html });
}

// A tela de nova senha confere o link ao abrir: usado, vencido ou trocado por um mais novo, ela avisa antes de a pessoa
// digitar a senha. O token tem 32 bytes aleatórios: a resposta não ajuda a adivinhar nenhum.
export async function checkResetToken(token: string) {
  if (!getSetting('Accounts_PasswordReset')) return false;
  const u = await one('SELECT u.* FROM password_resets p JOIN users u ON u.id = p.user_id WHERE p.token_hash = $1 AND p.expires_at > now()', [sha256(token)]);
  return !!u && canResetPassword(u);
}

export async function resetPasswordWithToken(token: string, password: string, ip?: string) {
  if (!getSetting('Accounts_PasswordReset')) throw forbidden('A redefinição de senha está desativada.');
  const invalid = () => badRequest('error-invalid-token', 'Link inválido ou expirado. Peça um novo em "Esqueci minha senha".');
  const pending = await one('SELECT * FROM password_resets WHERE token_hash = $1 AND expires_at > now()', [sha256(token)]);
  if (!pending) throw invalid();
  // A política de senha é conferida antes de gastar o link, para a pessoa poder tentar outra senha.
  validatePassword(password);
  const used = await one('DELETE FROM password_resets WHERE token_hash = $1 AND expires_at > now() RETURNING user_id', [sha256(token)]);
  if (!used) throw invalid();
  const u = await getUserById(used.user_id);
  if (!u || !canResetPassword(u)) throw invalid();
  await query('UPDATE users SET password_hash = $2, require_password_change = false, updated_at = now() WHERE id = $1', [u.id, await hashPassword(password)]);
  await query('DELETE FROM password_resets WHERE user_id = $1', [u.id]);
  // A pessoa provou ser dona do e-mail: os bloqueios da conta (também os de cada aparelho) saem.
  await query(`DELETE FROM login_attempts WHERE key = $1 OR starts_with(key, $1 || '|dev:')`, [loginKey(`id:${u.id}`)]);
  // Quem estava com a senha antiga (inclusive um invasor) sai de todos os dispositivos e perde os tokens de acesso.
  await revokeAllSessions(u.id, undefined, 'password-changed');
  const tokens = await revokePersonalTokens(u.id);
  await audit({ id: u.id, username: u.username, ip }, 'user.password.reset', { userId: u.id }, { tokensRevoked: tokens });
  if (u.email) {
    const { sendMail } = await import('./mailer');
    const site = getSetting<string>('Site_Name');
    void sendMail({
      to: u.email,
      subject: `[${site}] Sua senha foi alterada`,
      text: `Olá, ${u.name || u.username}.\n\nA senha da sua conta no ${site} acabou de ser redefinida: todas as sessões foram encerradas e os tokens de acesso foram revogados. Se não foi você, fale com o administrador imediatamente.`,
    });
  }
}

// ---------- 2FA ----------

// Papéis marcados como "exige 2FA" (cache curto; roles.update limpa o cache desta instância).
let mandatoryRoles = { at: 0, ids: new Set<string>() };
export function invalidateMandatory2faCache() {
  mandatoryRoles.at = 0;
}
async function mandatory2faRoles() {
  if (Date.now() - mandatoryRoles.at > 15_000) {
    const rows = await many('SELECT id FROM roles WHERE mandatory_2fa');
    mandatoryRoles = { at: Date.now(), ids: new Set(rows.map((r) => r.id)) };
  }
  return mandatoryRoles.ids;
}

// 2FA obrigatório vale para quem entra com senha local (inclusive contas vinculadas a SAML/OAuth que mantêm a senha);
// quem só entra pelo provedor (LDAP, SAML, OAuth) segue a política dele.
// Exigido para todos pela configuração ou por algum papel marcado como "exige 2FA".
export async function needs2faSetup(u: any) {
  if (!getSetting('Accounts_TwoFactorAuthentication_Enabled') || u.type === 'bot' || u.totp_enabled) return false;
  const passwordLogin = u.auth_source === 'local' || (u.auth_source !== 'ldap' && !!u.password_hash);
  if (!passwordLogin) return false;
  if (getSetting('Accounts_TwoFactorAuthentication_Enforce')) return true;
  const mandatory = await mandatory2faRoles();
  return (u.roles ?? []).some((r: string) => mandatory.has(r));
}

// O que a conta precisa resolver antes de usar o chat: trocar a senha ou configurar o 2FA.
export async function pendingSetup(u: any): Promise<'password' | '2fa' | null> {
  if (u.require_password_change) return 'password';
  return (await needs2faSetup(u)) ? '2fa' : null;
}

export async function enableTotp(ctx: Ctx) {
  const u = await getUserById(ctx.userId);
  // Gerar uma chave nova desligaria o 2FA atual sem pedir código: é preciso desativar antes (com código).
  if (u?.totp_enabled) throw badRequest('totp-already-enabled', 'O 2FA já está ativo. Desative-o com um código antes de configurar outro aplicativo.');
  const secret = generateSecret();
  await query('UPDATE users SET totp_secret = $2, totp_enabled = false, totp_last_step = NULL WHERE id = $1', [ctx.userId, secret]);
  return { secret, url: otpauthUrl(secret, ctx.username, getSetting<string>('Site_Name')) };
}

export async function verifyAndEnableTotp(ctx: Ctx, code: string) {
  const u = await getUserById(ctx.userId);
  const step = u?.totp_secret ? totpStep(u.totp_secret, code) : null;
  if (step === null) throw badRequest('invalid-totp', 'Código inválido.');
  const codes = Array.from({ length: 12 }, newBackupCode);
  // O código da ativação também já foi usado: não serve para entrar logo em seguida.
  await query('UPDATE users SET totp_enabled = true, backup_codes = $2, totp_last_step = $3 WHERE id = $1', [ctx.userId, codes.map((c) => sha256(normalizeBackupCode(c))), step]);
  await audit(actorOf(ctx), 'user.2fa.enabled', { userId: ctx.userId });
  return { codes };
}

export async function disableTotp(ctx: Ctx, code: string, password?: string) {
  const u = await getUserById(ctx.userId);
  if (!u?.totp_enabled) return;
  // Quem pegou uma sessão aberta não desliga o 2FA no chute: pede a senha (contas com senha do chat) e cada erro, de
  // senha ou de código, conta para um bloqueio de alguns minutos, como no login (com o bloqueio do login desligado,
  // 10 tentativas).
  const key = `2fa-disable:${u.id}`;
  const fail = async (e: ApiError) => (await countFailure(key, getSetting<number>('Accounts_Block_Failed_Login_Attempts') || 10), e);
  if (await one('SELECT 1 FROM login_attempts WHERE key = $1 AND blocked_until > now()', [key]))
    throw new ApiError(429, 'error-login-blocked', 'Muitas tentativas erradas. Tente novamente em alguns minutos.');
  if (asksPassword(u) && !(await verifyPassword(password ?? '', u.password_hash))) throw await fail(badRequest('error-invalid-password', 'Senha atual incorreta.'));
  if (!(await check2fa(u, code))) throw await fail(badRequest('invalid-totp', 'Código inválido ou já usado.'));
  await query('DELETE FROM login_attempts WHERE key = $1', [key]);
  await query("UPDATE users SET totp_enabled = false, totp_secret = NULL, backup_codes = '{}', totp_last_step = NULL WHERE id = $1", [ctx.userId]);
  await audit(actorOf(ctx), 'user.2fa.disabled', { userId: ctx.userId });
}

// ---------- Perfil ----------

// Campos de texto do perfil: número ou objeto é recusado (null vale como "não mudar"; no e-mail, como "sem e-mail").
const PROFILE_TEXT_FIELDS = { username: 'Nome de usuário', name: 'Nome', email: 'E-mail', password: 'Senha', bio: 'Sobre', statusText: 'Mensagem de status' };

export async function updateUser(
  actor: Ctx,
  userId: string,
  data: Partial<{ username: string; name: string; email: string; password: string; bio: string; statusText: string; active: boolean; requirePasswordChange: boolean; verified: boolean }>,
  opts: { asAdmin: boolean; currentPassword?: string },
) {
  const u = await getUserById(userId);
  if (!u) throw notFound('error-invalid-user', 'Usuário não encontrado.');
  const sets: string[] = [];
  const params: unknown[] = [userId];
  const self = actor.userId === userId;
  for (const [k, label] of Object.entries(PROFILE_TEXT_FIELDS)) {
    const v = (data as Record<string, unknown>)[k];
    if (v !== undefined && v !== null && typeof v !== 'string') throw badRequest('error-invalid-params', `O campo ${label} deve ser um texto.`);
  }
  // Só conta o que muda de fato: a tela pode mandar os campos como estavam (e uma conta antiga pode ter um valor fora
  // das regras de hoje). As travas do perfil, do LDAP e da senha atual valem para essas mudanças.
  // Nome de usuário vazio também é mudança: cai na validação, em vez de ser ignorado com "Perfil atualizado".
  const username = data.username != null && data.username !== u.username ? data.username : undefined;
  let name = data.name != null && data.name !== u.name ? normalizeName(data.name) : undefined;
  if (name === u.name) name = undefined;
  let bio = data.bio != null && data.bio !== (u.bio ?? '') ? normalizeBio(data.bio) : undefined;
  if (bio === (u.bio ?? '')) bio = undefined;
  const statusText = data.statusText != null ? data.statusText.slice(0, 120) : undefined;
  const statusChanged = statusText !== undefined && statusText !== (u.status_text ?? '');
  // E-mail vazio é "sem e-mail" (NULL): quem não tem e-mail salva o resto do perfil.
  const email = data.email === undefined ? undefined : normalizeEmail(data.email);
  const emailChanged = email !== undefined && email !== (u.email || null);
  if (!opts.asAdmin) {
    // "Permitir alterar perfil" vale para os dados do perfil; a senha segue só "Permitir alterar senha".
    if ((username !== undefined || name !== undefined || bio !== undefined || statusChanged || emailChanged) && !getSetting('Accounts_AllowUserProfileChange'))
      throw forbidden('Alteração de perfil desativada.');
    // Conta do LDAP: nome, nome de usuário e e-mail vêm do diretório (a sincronização grava por cima).
    if (u.auth_source === 'ldap' && (username !== undefined || name !== undefined || emailChanged))
      throw forbidden('Nome, nome de usuário e e-mail da sua conta vêm do diretório da empresa (LDAP) e são atualizados por lá.');
  }

  if (username !== undefined) {
    if (!opts.asAdmin && !getSetting('Accounts_AllowUsernameChange')) throw forbidden('Alteração de nome de usuário desativada.');
    validateUsername(username);
    const other = await getUserByUsername(username);
    if (other && other.id !== userId) throw badRequest('error-field-unavailable', 'Nome de usuário em uso.');
    sets.push(`username = $${params.push(username)}`);
  }
  if (name !== undefined) sets.push(`name = $${params.push(name)}`);
  if (bio !== undefined) sets.push(`bio = $${params.push(bio)}`);
  if (statusChanged) sets.push(`status_text = $${params.push(statusText)}`);
  if (emailChanged) {
    if (!opts.asAdmin) {
      if (!getSetting('Accounts_AllowEmailChange')) throw forbidden('Alteração de e-mail desativada.');
      // Sem senha do chat (conta só de SAML/OAuth) não há como confirmar quem pede; o provedor atualiza o e-mail.
      if (!u.password_hash) throw forbidden('Sua conta entra pelo provedor da empresa; o e-mail é atualizado por lá.');
      if (!email) throw badRequest('error-invalid-email', 'Informe o e-mail.');
    }
    if (email && !EMAIL_RE.test(email)) throw badRequest('error-invalid-email', 'E-mail inválido.');
    if (!opts.asAdmin) {
      assertAllowedDomain(email!);
      // O e-mail recebe o link de "Esqueci minha senha": com a sessão aberta e sem a senha, ninguém o troca.
      if (!opts.currentPassword) throw badRequest('error-password-required', 'Digite sua senha atual para trocar o e-mail.');
      if (!(await verifyPassword(opts.currentPassword, u.password_hash))) throw badRequest('error-invalid-password', 'Senha atual incorreta.');
    }
    const other = email && (await one('SELECT id FROM users WHERE lower(email) = lower($1)', [email]));
    if (other && other.id !== userId) throw badRequest('error-field-unavailable', 'E-mail em uso.');
    sets.push(`email = $${params.push(email)}`, `email_verified = ${opts.asAdmin && data.verified && email ? 'true' : 'false'}`);
  }
  if (data.password) {
    // Na troca obrigatória (logo após entrar com a senha provisória) a senha atual não é pedida de novo.
    if (!opts.asAdmin && !(self && u.require_password_change)) {
      if (!getSetting('Accounts_AllowPasswordChange')) throw forbidden('Alteração de senha desativada.');
      // LDAP e contas só de SAML/OAuth entram pelo provedor: uma senha do chat criada aqui continuaria valendo depois
      // que a TI desligasse a pessoa lá (vinculadas que mantêm a senha local continuam trocando com a senha atual).
      if (u.auth_source === 'ldap' || (u.auth_source !== 'local' && !u.password_hash)) throw forbidden('Sua conta entra pelo provedor da empresa; a senha é trocada lá.');
      if (u.password_hash && !(await verifyPassword(opts.currentPassword ?? '', u.password_hash))) throw badRequest('error-invalid-password', 'Senha atual incorreta.');
    }
    // Só espaços passava pelo tamanho mínimo.
    if (!data.password.trim()) throw badRequest('error-password-policy-not-met', 'A senha não pode ser só espaços.');
    validatePassword(data.password);
    // Na troca obrigatória, ficar com a senha provisória (que o administrador conhece) anularia a exigência.
    if (!opts.asAdmin && u.password_hash && (await verifyPassword(data.password, u.password_hash)))
      throw badRequest('error-password-same', 'A senha nova precisa ser diferente da atual.');
    sets.push(`password_hash = $${params.push(await hashPassword(data.password))}`);
    // Senha provisória com "Exigir troca de senha" na mesma gravação: vale o que a administração pediu.
    if (!(opts.asAdmin && data.requirePasswordChange !== undefined)) sets.push('require_password_change = false');
  }
  if (opts.asAdmin) {
    if (data.active === false && u.active) {
      // Como tirar o papel e excluir: ninguém se tranca para fora, e a empresa nunca fica sem administrador ativo.
      if (self) throw badRequest('error-action-not-allowed', 'Você não pode desativar a própria conta.');
      const last = await one(
        `SELECT EXISTS (SELECT 1 FROM roles WHERE is_root AND id = ANY($2::text[]))
            AND NOT EXISTS (SELECT 1 FROM users WHERE active AND id <> $1 AND roles && ARRAY(SELECT id FROM roles WHERE is_root)) AS last`,
        [userId, u.roles],
      );
      if (last?.last) throw badRequest('error-action-not-allowed', 'Não é possível desativar o último administrador ativo.');
    }
    if (data.active !== undefined) {
      sets.push(`active = $${params.push(data.active)}`);
      // Ativar um cadastro que aguardava aprovação é aprovar.
      if (data.active && u.pending_approval) sets.push('pending_approval = false');
      // "Ativo" mudado à mão é decisão do administrador: a sincronização do LDAP só reativa o que ela mesma desativou.
      if (data.active !== u.active) sets.push('ldap_deactivated_at = NULL', 'ldap_deactivated_reason = NULL');
    }
    if (data.requirePasswordChange !== undefined) sets.push(`require_password_change = $${params.push(data.requirePasswordChange)}`);
    if (data.verified !== undefined && data.email === undefined) sets.push(`email_verified = $${params.push(data.verified)}`);
  }
  if (!sets.length) return u;
  sets.push('updated_at = now()');
  const row = await one(`UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params).catch((e) => {
    throw isEmailConflict(e) ? badRequest('error-field-unavailable', 'E-mail em uso.') : e;
  });
  if (data.username && data.username !== u.username) await propagateUsername(userId, u.username, data.username);
  if (name !== undefined) await query('UPDATE messages SET user_name = $2 WHERE user_id = $1', [userId, name]);
  if (data.active === false) {
    await revokeAllSessions(userId, undefined, 'deactivated');
    // Também os sockets abertos com token de acesso pessoal (a API já recusa a conta desativada).
    bus.forceLogout({ userId, reason: 'deactivated' });
  }
  if (data.password && !self) {
    await revokeAllSessions(userId, undefined, 'password-changed');
    await revokePersonalTokens(userId);
    // A pessoa fica sabendo que a senha mudou (e por quem), como na redefinição por e-mail.
    if (row.email) {
      const { sendMail } = await import('./mailer');
      const site = getSetting<string>('Site_Name');
      void sendMail({
        to: row.email,
        subject: `[${site}] Sua senha foi alterada`,
        text: `Olá, ${row.name || row.username}.\n\nUm administrador trocou a senha da sua conta no ${site} e as sessões abertas foram encerradas. Peça a senha nova a quem administra o chat. Se você não esperava por isso, avise o administrador.`,
      });
    }
  }
  if (data.active && u.pending_approval && !u.active && row.email) {
    // Cadastro aprovado: a pessoa que se cadastrou fica sabendo que já pode entrar.
    const { sendMail } = await import('./mailer');
    const { siteUrl } = await import('./sso');
    const site = getSetting<string>('Site_Name');
    void sendMail({
      to: row.email,
      subject: `[${site}] Cadastro aprovado`,
      text: `Olá, ${row.name || row.username}.\n\nSeu cadastro no ${site} foi aprovado. Você já pode entrar com o nome de usuário "${row.username}" e a senha que escolheu:\n\n${siteUrl()}/login`,
    });
  }
  if (!self || data.active !== undefined) {
    await audit(actorOf(actor), 'user.updated', { userId, username: row.username }, { fields: Object.keys(data).filter((k) => k !== 'password'), passwordChanged: !!data.password });
  }
  bus.publish({ all: true }, { type: 'user', action: 'updated', user: mapUser(row) });
  // A mensagem de status (e o @usuário novo) chegam aos outros pela presença, como na troca pelo menu da foto.
  if (statusChanged || username) bus.publish({ all: true }, presenceEvent(row));
  // Conversas diretas: o nome na barra lateral e no topo da conversa de quem fala com a pessoa.
  if (username || name !== undefined) void republishDirect(userId, !!username).catch(() => {});
  if (emailChanged && !opts.asAdmin && u.email) void notifyEmailChanged(u, email!).catch(() => {});
  return row;
}

async function republishDirect(userId: string, usernameChanged: boolean) {
  const { notifyRoomUpdated, republishSubscriptions } = await import('./rooms');
  for (const r of await many(`SELECT id FROM rooms WHERE t = 'd' AND $1 = ANY(uids)`, [userId])) {
    await republishSubscriptions(r.id);
    if (usernameChanged) await notifyRoomUpdated(r.id);
  }
}

// O endereço antigo fica sabendo da troca: se não foi a pessoa, ela avisa antes de alguém usar "Esqueci minha senha".
async function notifyEmailChanged(u: any, email: string) {
  const { sendMail } = await import('./mailer');
  const site = getSetting<string>('Site_Name');
  await sendMail({
    to: u.email,
    subject: `[${site}] O e-mail da sua conta foi alterado`,
    text: `Olá, ${u.name || u.username}.\n\nO e-mail da sua conta no ${site} foi trocado para ${email}. A partir de agora os avisos e o link de "Esqueci minha senha" vão para esse endereço.\n\nSe não foi você, fale com o administrador do chat imediatamente.`,
  });
}

async function propagateUsername(userId: string, oldU: string, newU: string) {
  await query('UPDATE messages SET username = $2 WHERE user_id = $1', [userId, newU]);
  await query(
    // A conversa arquivada com uma conta excluída guarda em fname o nome de quem saiu.
    `UPDATE rooms SET usernames = array_replace(usernames, $1, $2), fname = CASE WHEN archived THEN fname END WHERE t = 'd' AND $3 = ANY(uids)`,
    [oldU, newU, userId],
  );
  await renameInReactions(oldU, newU);
}

// As reações guardam o @usuário, não o id da conta (messages.reactions = { ":x:": { usernames: [...] } }). Troca o nome
// antigo pelo novo (conta renomeada) ou tira o nome (newU null, conta excluída): um @usuário reaproveitado nunca herda
// as reações de outra pessoa, nem no chat nem em "Meus dados". Uma passada pelas mensagens com reação (é raro).
async function renameInReactions(oldU: string, newU: string | null, db?: Queryable) {
  await query(
    `UPDATE messages m SET updated_at = now(), reactions = COALESCE(
       (SELECT jsonb_object_agg(e.key, e.value || jsonb_build_object('usernames', s.us))
          FROM jsonb_each(m.reactions) e
          CROSS JOIN LATERAL (
            SELECT jsonb_agg(d.v ORDER BY d.o) AS us FROM (
              SELECT DISTINCT ON (r.v) r.v, r.o FROM (
                SELECT CASE WHEN a.x = to_jsonb($1::text) THEN to_jsonb($2::text) ELSE a.x END AS v, a.o
                  FROM jsonb_array_elements(COALESCE(e.value->'usernames', '[]'::jsonb)) WITH ORDINALITY a(x, o)) r
               WHERE r.v IS NOT NULL ORDER BY r.v, r.o) d) s
         WHERE s.us IS NOT NULL),
       '{}'::jsonb)
     WHERE m.reactions <> '{}'::jsonb AND jsonb_path_exists(m.reactions, '$.*.usernames[*] ? (@ == $u)', jsonb_build_object('u', $1::text))`,
    [oldU, newU],
    db,
  );
}

// As preferências que users.setPreferences aceita e os valores de cada uma (highlights e language têm validação
// própria, abaixo). Preferência nova: acrescente aqui, senão o servidor a recusa.
const PREFERENCE_VALUES: Record<string, readonly string[] | 'boolean'> = {
  theme: ['auto', 'light', 'dark'],
  desktopNotifications: ['all', 'mentions', 'nothing'],
  emailNotificationMode: ['mentions', 'nothing'],
  stickerAnimation: ['system', 'auto', 'hover', 'never'],
  notificationSound: 'boolean',
  sendOnEnter: 'boolean',
  showThreadsInMainChannel: 'boolean',
  sidebarGroupByType: 'boolean',
  sidebarShowUnread: 'boolean',
  hideReadReceipts: 'boolean',
  stickerSuggestions: 'boolean',
  stickerTabSeen: 'boolean',
  stickerHintSeen: 'boolean',
};

// Preferências da pessoa (merge no jsonb). As palavras destacadas são validadas e normalizadas aqui. Qualquer mudança
// vai para as outras abas da pessoa pelo evento "user" (só para ela: os outros nunca veem preferences).
export async function setPreferences(ctx: Ctx, prefs: UserPreferences) {
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) throw badRequest('error-invalid-params', 'Preferências inválidas.');
  const data: Record<string, unknown> = { ...prefs };
  // Só as preferências conhecidas, com valores válidos (um valor qualquer desligava as notificações sem aviso, e
  // chaves inventadas iam no /me de cada abertura). null tira a chave: a preferência volta ao padrão.
  const remove: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (k === 'highlights' || k === 'language') continue;
    const allowed = Object.hasOwn(PREFERENCE_VALUES, k) ? PREFERENCE_VALUES[k] : undefined;
    if (v === null) {
      delete data[k];
      remove.push(k);
    } else if (!allowed) throw badRequest('error-invalid-params', `Preferência desconhecida: ${k.slice(0, 60)}.`);
    else if (allowed === 'boolean' ? typeof v !== 'boolean' : !allowed.includes(v as string)) throw badRequest('error-invalid-params', `Valor inválido para a preferência ${k}.`);
  }
  if ('highlights' in data) {
    const r = normalizeHighlights(data.highlights);
    if (!r.ok) throw badRequest('error-invalid-highlights', r.error);
    data.highlights = r.words;
  }
  // Idioma da pessoa (destino das traduções de mensagens). Vazio volta ao padrão da empresa: a chave sai.
  const drop: string[] = remove;
  if ('language' in data) {
    const v = data.language;
    if (v === '' || v === null || v === undefined) {
      delete data.language;
      drop.push('language');
    } else if (typeof v !== 'string' || !LANG_RE.test(v.trim())) throw badRequest('error-invalid-params', 'Idioma inválido.');
    else data.language = normalizeLang(v);
  }
  const before = await one('SELECT preferences FROM users WHERE id = $1', [ctx.userId]);
  const row = await one(`UPDATE users SET preferences = (preferences - $3::text[]) || $2::jsonb, updated_at = now() WHERE id = $1 RETURNING *`, [
    ctx.userId,
    JSON.stringify(data),
    drop,
  ]);
  if (row && JSON.stringify(before?.preferences ?? {}) !== JSON.stringify(row.preferences ?? {})) {
    bus.publish({ user: row.id }, { type: 'user', action: 'updated', user: { _id: row.id, preferences: row.preferences } });
  }
  return row;
}

// Status escolhido. customId: o status personalizado (o tipo dele vem em status); escolher um status de base limpa o
// personalizado. Todos recebem a presença; só a própria pessoa recebe a escolha (statusDefault diria "escolheu
// Invisível" aos outros), para as outras abas marcarem o item certo no menu.
export async function setStatus(userId: string, status: UserStatus | undefined, statusText?: string, customId: string | null = null) {
  const sets: string[] = [];
  const params: unknown[] = [userId];
  if (status) {
    sets.push(`status_default = $${params.push(status)}`);
    // Status real só muda se o usuário estiver conectado; offline continua offline.
    sets.push(`status = CASE WHEN EXISTS (SELECT 1 FROM presence_connections WHERE user_id = $1) THEN $${params.length} ELSE 'offline' END`);
    sets.push(`status_custom = $${params.push(customId)}`);
  }
  if (statusText !== undefined) sets.push(`status_text = $${params.push(clampStatusText(statusText))}`);
  if (!sets.length) return;
  const row = await one(`UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING id, username, status, status_text, status_default, status_custom`, params);
  if (!row) return;
  bus.publish({ all: true }, presenceEvent(row));
  if (status) bus.publish({ user: row.id }, { type: 'user', action: 'updated', user: { _id: row.id, statusDefault: row.status_default, statusCustom: row.status_custom } });
}

export async function deleteUser(actor: Ctx, userId: string, opts: { confirmRelinquish?: boolean } = {}) {
  const u = await getUserById(userId);
  if (!u) throw notFound('error-invalid-user', 'Usuário não encontrado.');
  if (u.roles.includes('admin')) {
    const admins = await one(`SELECT count(*)::int AS n FROM users WHERE 'admin' = ANY(roles) AND active`);
    if (admins.n <= 1) throw badRequest('error-action-not-allowed', 'Não é possível remover o último administrador.');
  }
  // Criptografia de ponta a ponta: as chaves da conta saem em cascata; as salas em que ela tinha chave trocam de chave.
  const { markRotate, roomsWithKeysOf } = await import('./e2e');
  let e2eRooms: string[] = [];
  const keptDms: string[] = [];
  let calendarPeople: string[] = [];
  await tx(async (c) => {
    e2eRooms = await roomsWithKeysOf(userId, c);
    // Salas onde ele é o único dono: transferem para o membro mais antigo.
    const owned = await c.query(`SELECT room_id FROM subscriptions WHERE user_id = $1 AND 'owner' = ANY(roles)`, [userId]);
    for (const { room_id } of owned.rows) {
      const others = await c.query(`SELECT 1 FROM subscriptions WHERE room_id = $1 AND user_id <> $2 AND 'owner' = ANY(roles)`, [room_id, userId]);
      if (!others.rowCount) {
        await c.query(
          `UPDATE subscriptions SET roles = array_append(roles, 'owner') WHERE id = (SELECT id FROM subscriptions WHERE room_id = $1 AND user_id <> $2 ORDER BY created_at LIMIT 1)`,
          [room_id, userId],
        );
      }
    }
    // Conversas diretas são também dos outros participantes: a conversa em grupo continua para quem fica, com todo o
    // histórico (só a pessoa sai dela); a conversa a dois fica arquivada para a outra pessoa reler, com o nome de quem
    // saiu. Só some a conversa em que não sobra ninguém com conta.
    const dms = await c.query(
      `SELECT r.id, r.uids, ARRAY(SELECT x FROM unnest(r.uids) x WHERE x <> $1 AND EXISTS (SELECT 1 FROM users o WHERE o.id = x)) AS rest
         FROM rooms r WHERE r.t = 'd' AND $1 = ANY(r.uids)`,
      [userId],
    );
    for (const r of dms.rows) {
      if (!r.rest.length) await c.query('DELETE FROM rooms WHERE id = $1', [r.id]);
      else if (r.rest.length > 1)
        await c.query(`UPDATE rooms SET uids = array_remove(uids, $2), usernames = array_remove(usernames, $3), fname = NULL, updated_at = now() WHERE id = $1`, [r.id, userId, u.username]);
      else await c.query(`UPDATE rooms SET archived = true, fname = $2, updated_at = now() WHERE id = $1`, [r.id, `${u.name || u.username} (conta excluída)`]);
      if (r.rest.length) keptDms.push(r.id);
    }
    // Agenda: o evento com convidados que a pessoa organizava continua, organizado pelo convidado mais antigo (quem
    // aceitou vem antes e quem recusou por último), como o dono de sala. Evento só dela sai com a conta.
    const handed = await c.query(
      `WITH next AS (
         SELECT DISTINCT ON (a.event_id) a.event_id, a.user_id FROM calendar_attendees a
           JOIN calendar_events e ON e.id = a.event_id JOIN users o ON o.id = a.user_id
          WHERE e.owner_id = $1 AND a.user_id <> $1
          ORDER BY a.event_id, o.active DESC, CASE a.response WHEN 'accepted' THEN 0 WHEN 'tentative' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END, a.added_at, a.user_id)
       UPDATE calendar_events e SET owner_id = next.user_id, updated_at = now() FROM next WHERE e.id = next.event_id
       RETURNING e.id, next.user_id`,
      [userId],
    );
    if (handed.rowCount) {
      const ids = handed.rows.map((h) => h.id);
      await c.query(`DELETE FROM calendar_attendees a USING unnest($1::text[], $2::text[]) h(event_id, user_id) WHERE a.event_id = h.event_id AND a.user_id = h.user_id`, [
        ids,
        handed.rows.map((h) => h.user_id),
      ]);
      const att = await c.query(`SELECT DISTINCT user_id FROM calendar_attendees WHERE event_id = ANY($1)`, [ids]);
      calendarPeople = [...new Set([...handed.rows.map((h) => h.user_id as string), ...att.rows.map((a) => a.user_id as string)])];
    }
    const subs = await c.query('DELETE FROM subscriptions WHERE user_id = $1 RETURNING room_id', [userId]);
    for (const { room_id } of subs.rows) await c.query('UPDATE rooms SET users_count = GREATEST(users_count - 1, 0) WHERE id = $1', [room_id]);
    // Na mesma transação: ninguém pega o @usuário e reage antes de as reações da conta saírem.
    await renameInReactions(u.username, null, c);
    await c.query('DELETE FROM users WHERE id = $1', [userId]);
  });
  await markRotate(e2eRooms);
  bus.forceLogout({ userId });
  // Quem ficou nas conversas diretas vê o nome novo (e a conversa arquivada) sem recarregar; a agenda também.
  if (keptDms.length) {
    const { notifyRoomUpdated, republishSubscriptions } = await import('./rooms');
    for (const rid of keptDms) {
      await notifyRoomUpdated(rid);
      await republishSubscriptions(rid);
    }
  }
  if (calendarPeople.length) bus.publish({ users: calendarPeople }, { type: 'calendar.changed' });
  await audit(actorOf(actor), 'user.deleted', { userId, username: u.username }, { relinquish: !!opts.confirmRelinquish, keptDirect: keptDms.length });
}

// ---------- Avatar ----------

export async function setAvatar(userId: string, _declaredType: string, data: Buffer) {
  // O tipo vem do conteúdo, não do que o navegador (ou o provedor) declarou: um PDF renomeado para .png virava uma foto
  // quebrada para todo mundo.
  const { imageType } = await import('../importer/pending');
  const contentType = imageType(data);
  if (!contentType) throw badRequest('error-invalid-image', 'O arquivo não é uma imagem PNG, JPEG, GIF ou WebP.');
  if (data.length > 5 * 1024 * 1024) throw badRequest('error-file-too-large', 'Imagem muito grande (máx. 5 MB).');
  const etag = newId(8);
  await query(
    `INSERT INTO avatars (user_id, content_type, data) VALUES ($1,$2,$3)
     ON CONFLICT (user_id) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data, updated_at = now()`,
    [userId, contentType, data],
  );
  const row = await one('UPDATE users SET avatar_etag = $2 WHERE id = $1 RETURNING *', [userId, etag]);
  bus.publish({ all: true }, { type: 'user', action: 'updated', user: { _id: userId, avatarETag: etag, username: row.username } });
  return etag;
}

export async function resetAvatar(userId: string) {
  await query('DELETE FROM avatars WHERE user_id = $1', [userId]);
  const row = await one('UPDATE users SET avatar_etag = NULL WHERE id = $1 RETURNING username', [userId]);
  bus.publish({ all: true }, { type: 'user', action: 'updated', user: { _id: userId, avatarETag: null, username: row?.username } });
}

// ---------- Tokens pessoais ----------

// Pede a senha (contas com senha local) e o código do 2FA (quando ligado), como redefinir a criptografia: uma sessão
// roubada não vira um acesso à API que fica depois de a pessoa recuperar a conta.
export async function createPersonalToken(ctx: Ctx, name: string, bypass2fa: boolean, confirm: { password?: string; code?: string } = {}) {
  const token = randomToken();
  // Espaços sobrando não contam, e o nome não se repete mudando só maiúsculas ou espaços: na lista ficariam iguais.
  name = name.replace(/\s+/g, ' ').trim();
  if (!name) throw badRequest('error-invalid-params', 'Informe o nome do token.');
  const same = (other: string) => other.replace(/\s+/g, ' ').trim().toLowerCase() === name.toLowerCase();
  if ((await many<{ name: string }>('SELECT name FROM personal_access_tokens WHERE user_id = $1', [ctx.userId])).some((t) => same(t.name)))
    throw badRequest('error-token-already-exists', 'Já existe um token com esse nome.');
  const u = await getUserById(ctx.userId);
  if (asksPassword(u) && !(await verifyPassword(confirm.password ?? '', u.password_hash))) throw badRequest('error-invalid-password', 'Senha atual incorreta.');
  if (u.totp_enabled && getSetting('Accounts_TwoFactorAuthentication_Enabled') && !(await check2fa(u, confirm.code ?? '')))
    throw badRequest('invalid-totp', 'Código de verificação inválido ou já usado.');
  await query('INSERT INTO personal_access_tokens (id, user_id, name, token_hash, bypass_2fa) VALUES ($1,$2,$3,$4,$5)', [
    newId(),
    ctx.userId,
    name,
    sha256(token),
    bypass2fa,
  ]);
  await audit(actorOf(ctx), 'user.token.created', { name });
  return token;
}

export async function listPersonalTokens(userId: string) {
  const rows = await many('SELECT id, name, bypass_2fa, created_at, last_used_at FROM personal_access_tokens WHERE user_id = $1 ORDER BY created_at', [userId]);
  return rows.map((r) => ({ _id: r.id, name: r.name, bypassTwoFactor: r.bypass_2fa, createdAt: r.created_at, lastTokenPart: '', lastUsedAt: r.last_used_at }));
}

export async function removePersonalToken(userId: string, name: string) {
  const rows = await many('DELETE FROM personal_access_tokens WHERE user_id = $1 AND name = $2 RETURNING id', [userId, name]);
  if (rows.length) bus.forceLogout({ sessionIds: rows.map((r) => `pat:${r.id}`) });
}

// ---------- Primeira execução ----------

export async function ensureAdmin(username: string, password: string | null, email: string, log: (m: string) => void) {
  const has = await one(`SELECT 1 FROM users WHERE 'admin' = ANY(roles) LIMIT 1`);
  if (has) return;
  const pw = password ?? randomToken(9);
  await createUser({ username, name: 'Administrador', email, password: pw, roles: ['admin', 'user'], verified: true, skipPasswordPolicy: true });
  log(`Administrador criado: usuário "${username}"${password ? '' : `, senha "${pw}" (troque após o primeiro login)`}`);
}
