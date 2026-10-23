import type { UserPreferences, UserStatus } from '@shared/index';
import { many, one, query, tx } from '../db/pool';
import { ApiError, badRequest, forbidden, notFound, unauthorized } from '../lib/errors';
import { newId, randomToken, sha256 } from '../lib/ids';
import { hashPassword, verifyPassword } from '../lib/password';
import { generateSecret, otpauthUrl, verifyTotp } from '../lib/totp';
import { bus } from '../realtime/bus';
import { audit, type Actor } from './audit';
import { mapUser } from './mappers';
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

export function validateUsername(username: string) {
  if (!USERNAME_RE.test(username)) throw badRequest('error-invalid-username', 'Nome de usuário inválido (2-40 caracteres: letras, números, ponto, hífen, sublinhado).');
}

export function validatePassword(password: string) {
  const min = getSetting<number>('Accounts_Password_Policy_MinLength');
  const errs: string[] = [];
  if (password.length < min) errs.push(`mínimo de ${min} caracteres`);
  if (getSetting('Accounts_Password_Policy_AtLeastOneUppercase') && !/[A-Z]/.test(password)) errs.push('uma letra maiúscula');
  if (getSetting('Accounts_Password_Policy_AtLeastOneNumber') && !/[0-9]/.test(password)) errs.push('um número');
  if (getSetting('Accounts_Password_Policy_AtLeastOneSpecialCharacter') && !/[^A-Za-z0-9]/.test(password)) errs.push('um caractere especial');
  if (errs.length) throw badRequest('error-password-policy-not-met', `A senha precisa de: ${errs.join(', ')}.`);
}

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

export async function createUser(input: CreateUserInput, actor?: Actor) {
  validateUsername(input.username);
  if (input.email && !EMAIL_RE.test(input.email)) throw badRequest('error-invalid-email', 'E-mail inválido.');
  if (input.password && !input.skipPasswordPolicy) validatePassword(input.password);
  if (await getUserByUsername(input.username)) throw badRequest('error-field-unavailable', `O nome de usuário ${input.username} já está em uso.`);
  if (input.email && (await one('SELECT 1 FROM users WHERE lower(email) = lower($1)', [input.email])))
    throw badRequest('error-field-unavailable', 'Este e-mail já está em uso.');
  const id = newId();
  const hash = input.password ? await hashPassword(input.password) : null;
  const row = await one(
    `INSERT INTO users (id, username, name, email, email_verified, password_hash, active, type, roles, auth_source, external_id, require_password_change)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [
      id,
      input.username,
      input.name ?? input.username,
      input.email ?? null,
      input.verified ?? false,
      hash,
      input.active ?? true,
      input.type ?? 'user',
      input.roles?.length ? input.roles : ['user'],
      input.authSource ?? 'local',
      input.externalId ?? null,
      input.requirePasswordChange ?? false,
    ],
  );
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
  const domains = String(getSetting('Accounts_AllowedDomainsList') ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  if (domains.length && !domains.includes(input.email.split('@')[1]?.toLowerCase()))
    throw badRequest('error-invalid-domain', 'Domínio de e-mail não permitido.');
  const manual = getSetting<boolean>('Accounts_ManuallyApproveNewUsers');
  const row = await createUser({ username: input.username, name: input.name, email: input.email, password: input.pass, active: !manual });
  await audit({ id: row.id, username: row.username, ip }, 'user.registered', { userId: row.id });
  return row;
}

// ---------- Login e sessões ----------

// ---------- Bloqueio por tentativas falhas (no banco, vale para todas as instâncias) ----------

// O contador do login usa o id da conta quando ela existe (usuário e e-mail contam juntos).
const loginKey = (login: string) => `user:${login.trim().toLowerCase()}`;

function attemptKeys(login: string, ip?: string) {
  const keys: { key: string; max: number }[] = [];
  const byUser = getSetting<number>('Accounts_Block_Failed_Login_Attempts');
  const byIp = getSetting<number>('Accounts_Block_Failed_Login_Attempts_By_Ip');
  if (byUser > 0) keys.push({ key: loginKey(login), max: byUser });
  if (byIp > 0 && ip) keys.push({ key: `ip:${ip}`, max: byIp });
  return keys;
}

const blockMinutes = () => Math.max(1, getSetting<number>('Accounts_Block_Failed_Login_Minutes') || 5);

async function assertNotBlocked(login: string, ip?: string) {
  const keys = attemptKeys(login, ip).map((k) => k.key);
  if (!keys.length) return;
  const r = await one('SELECT max(blocked_until) AS until FROM login_attempts WHERE key = ANY($1) AND blocked_until > now()', [keys]);
  if (r?.until) throw new ApiError(429, 'error-login-blocked', 'Muitas tentativas falhas. Tente novamente em alguns minutos.');
}

async function recordFailedAttempt(login: string, ip?: string) {
  const minutes = blockMinutes();
  for (const { key, max } of attemptKeys(login, ip)) {
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
}

async function clearFailedAttempts(login: string) {
  // Só zera o contador do login: o do IP continua (senão bastaria entrar numa conta própria entre as tentativas).
  await query('DELETE FROM login_attempts WHERE key = $1', [loginKey(login)]);
}

export interface DeviceInfo {
  userAgent?: string;
  ip?: string;
  name?: string;
}

function parseDevice(d: DeviceInfo) {
  const ua = d.userAgent ?? '';
  const os = /Windows/i.test(ua) ? 'Windows' : /Mac OS X/i.test(ua) ? 'macOS' : /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS' : /Linux/i.test(ua) ? 'Linux' : 'Desconhecido';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : ua ? 'Outro' : 'API';
  return { userAgent: ua, ip: d.ip, os, browser, name: d.name ?? `${browser} em ${os}` };
}

export async function createSession(userId: string, device: DeviceInfo) {
  const token = randomToken();
  const id = newId();
  const days = getSetting<number>('Accounts_LoginExpiration') || 90;
  await query(
    `INSERT INTO sessions (id, user_id, token_hash, device, expires_at) VALUES ($1,$2,$3,$4, now() + ($5 || ' days')::interval)`,
    [id, userId, sha256(token), JSON.stringify(parseDevice(device)), String(days)],
  );
  await query('UPDATE users SET last_login = now() WHERE id = $1', [userId]);
  void recordActivity(userId, 'session');
  return { sessionId: id, authToken: token };
}

export class TwoFactorRequired extends Error {
  constructor(public method: 'totp') {
    super('totp-required');
  }
}

export async function login(params: { user: string; password: string; code?: string; device: DeviceInfo }) {
  let user = await findUserForLogin(params.user);
  const attemptLogin = user ? `id:${user.id}` : params.user;
  await assertNotBlocked(attemptLogin, params.device.ip);
  let ok = false;
  if (getSetting('LDAP_Enable') && (!user || user.auth_source === 'ldap')) {
    const { ldapLogin } = await import('../ldap/ldap');
    const r = await ldapLogin(params.user, params.password); // só lança o conflito de conta (409)
    if (r.status === 'ok') {
      user = r.user;
      ok = true;
    } else if (r.status === 'unavailable' && user && getSetting('LDAP_Login_Fallback')) {
      // Servidor fora do ar: vale a senha local. Recusa do diretório (senha errada, conta desativada) não cai aqui.
      ok = await verifyPassword(params.password, user.password_hash);
    }
  } else if (user) {
    ok = await verifyPassword(params.password, user.password_hash);
  }
  if (!ok) user = null;

  if (!user) {
    await recordFailedAttempt(attemptLogin, params.device.ip);
    await audit({ ip: params.device.ip, username: params.user }, 'auth.login.failed', { login: params.user });
    throw unauthorized('Usuário ou senha incorretos.');
  }
  if (!user.active) throw unauthorized('Usuário desativado ou aguardando aprovação.');
  if (user.totp_enabled && getSetting('Accounts_TwoFactorAuthentication_Enabled')) {
    if (!params.code) throw new TwoFactorRequired('totp');
    if (!(await check2fa(user, params.code))) {
      // Código errado conta como tentativa falha (senão o código de 6 dígitos poderia ser adivinhado).
      await recordFailedAttempt(attemptLogin, params.device.ip);
      await audit({ id: user.id, username: user.username, ip: params.device.ip }, 'auth.login.failed', { login: params.user, reason: 'totp' });
      throw unauthorized('Código de verificação inválido.');
    }
  }
  await clearFailedAttempts(attemptLogin);
  const s = await createSession(user.id, params.device);
  await audit({ id: user.id, username: user.username, ip: params.device.ip }, 'auth.login', { sessionId: s.sessionId });
  return { user, ...s };
}

async function check2fa(user: any, code: string) {
  if (user.totp_secret && verifyTotp(user.totp_secret, code)) return true;
  const hashed = sha256(code.trim());
  if (user.backup_codes.includes(hashed)) {
    await query('UPDATE users SET backup_codes = array_remove(backup_codes, $2) WHERE id = $1', [user.id, hashed]);
    return true;
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

export async function logout(sessionId: string) {
  await query('DELETE FROM sessions WHERE id = $1', [sessionId]);
  bus.forceLogout({ sessionIds: [sessionId] });
}

export async function listSessions(opts: { userId?: string; offset?: number; count?: number; search?: string }) {
  const params: unknown[] = [];
  const where: string[] = ['s.expires_at > now()'];
  if (opts.userId) where.push(`s.user_id = $${params.push(opts.userId)}`);
  if (opts.search) where.push(`(u.username ILIKE $${params.push(`%${opts.search}%`)} OR s.device->>'ip' ILIKE $${params.length})`);
  const rows = await many(
    `SELECT s.*, u.username, count(*) OVER() AS total FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE ${where.join(' AND ')} ORDER BY s.last_active_at DESC LIMIT ${Math.min(opts.count ?? 50, 200)} OFFSET ${Number(opts.offset ?? 0)}`,
    params,
  );
  return {
    total: Number(rows[0]?.total ?? 0),
    sessions: rows.map((r) => ({
      _id: r.id,
      userId: r.user_id,
      username: r.username,
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
  await logout(sessionId);
  await audit(actorOf(ctx), 'session.revoked', { sessionId, userId: s.user_id });
}

export async function revokeAllSessions(userId: string, exceptSessionId?: string) {
  const rows = await many('DELETE FROM sessions WHERE user_id = $1 AND id <> $2 RETURNING id', [userId, exceptSessionId ?? '']);
  if (rows.length) bus.forceLogout({ sessionIds: rows.map((r) => r.id) });
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

export async function sendPasswordSetupEmail(userId: string) {
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
  const text = `Olá, ${u.name || u.username}.\n\nSua conta no ${site} foi criada com o nome de usuário "${u.username}". Para definir a sua senha, abra o link abaixo em até 3 dias:\n\n${link}\n\nDepois desse prazo, use "Esqueci minha senha" na tela de login.`;
  const html = `<p>Olá, ${escapeHtml(u.name || u.username)}.</p><p>Sua conta no ${escapeHtml(site)} foi criada com o nome de usuário <b>${escapeHtml(u.username)}</b>. Para definir a sua senha, clique no botão abaixo em até 3 dias:</p><p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;background:#1d74f5;color:#fff;border-radius:6px;text-decoration:none">Definir senha</a></p><p style="color:#6c727a">Depois desse prazo, use "Esqueci minha senha" na tela de login.</p>`;
  return sendMail({ to: u.email, subject: `Defina sua senha no ${site}`, text, html });
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
  await query('DELETE FROM login_attempts WHERE key = $1', [loginKey(`id:${u.id}`)]);
  // Quem estava com a senha antiga (inclusive um invasor) sai de todos os dispositivos.
  await revokeAllSessions(u.id);
  await audit({ id: u.id, username: u.username, ip }, 'user.password.reset', { userId: u.id });
  if (u.email) {
    const { sendMail } = await import('./mailer');
    const site = getSetting<string>('Site_Name');
    void sendMail({
      to: u.email,
      subject: `[${site}] Sua senha foi alterada`,
      text: `Olá, ${u.name || u.username}.\n\nA senha da sua conta no ${site} acabou de ser redefinida e todas as sessões foram encerradas. Se não foi você, fale com o administrador imediatamente.`,
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
  await query('UPDATE users SET totp_secret = $2, totp_enabled = false WHERE id = $1', [ctx.userId, secret]);
  return { secret, url: otpauthUrl(secret, ctx.username, getSetting<string>('Site_Name')) };
}

export async function verifyAndEnableTotp(ctx: Ctx, code: string) {
  const u = await getUserById(ctx.userId);
  if (!u?.totp_secret || !verifyTotp(u.totp_secret, code)) throw badRequest('invalid-totp', 'Código inválido.');
  const codes = Array.from({ length: 12 }, () => randomToken(6).slice(0, 8));
  await query('UPDATE users SET totp_enabled = true, backup_codes = $2 WHERE id = $1', [ctx.userId, codes.map(sha256)]);
  await audit(actorOf(ctx), 'user.2fa.enabled', { userId: ctx.userId });
  return { codes };
}

export async function disableTotp(ctx: Ctx, code: string) {
  const u = await getUserById(ctx.userId);
  if (!u?.totp_enabled) return;
  if (!(await check2fa(u, code))) throw badRequest('invalid-totp', 'Código inválido.');
  await query("UPDATE users SET totp_enabled = false, totp_secret = NULL, backup_codes = '{}' WHERE id = $1", [ctx.userId]);
  await audit(actorOf(ctx), 'user.2fa.disabled', { userId: ctx.userId });
}

// ---------- Perfil ----------

export async function updateUser(
  actor: Ctx,
  userId: string,
  data: Partial<{ username: string; name: string; email: string; password: string; bio: string; statusText: string; active: boolean; roles: string[]; requirePasswordChange: boolean; verified: boolean }>,
  opts: { asAdmin: boolean; currentPassword?: string },
) {
  const u = await getUserById(userId);
  if (!u) throw notFound('error-invalid-user', 'Usuário não encontrado.');
  const sets: string[] = [];
  const params: unknown[] = [userId];
  const self = actor.userId === userId;
  if (!opts.asAdmin && !getSetting('Accounts_AllowUserProfileChange')) throw forbidden('Alteração de perfil desativada.');

  if (data.username !== undefined && data.username !== u.username) {
    if (!opts.asAdmin && !getSetting('Accounts_AllowUsernameChange')) throw forbidden('Alteração de nome de usuário desativada.');
    validateUsername(data.username);
    const other = await getUserByUsername(data.username);
    if (other && other.id !== userId) throw badRequest('error-field-unavailable', 'Nome de usuário em uso.');
    sets.push(`username = $${params.push(data.username)}`);
  }
  if (data.name !== undefined) sets.push(`name = $${params.push(data.name)}`);
  if (data.bio !== undefined) sets.push(`bio = $${params.push(data.bio)}`);
  if (data.statusText !== undefined) sets.push(`status_text = $${params.push(data.statusText.slice(0, 120))}`);
  if (data.email !== undefined && data.email !== u.email) {
    if (!opts.asAdmin && !getSetting('Accounts_AllowEmailChange')) throw forbidden('Alteração de e-mail desativada.');
    if (!EMAIL_RE.test(data.email)) throw badRequest('error-invalid-email', 'E-mail inválido.');
    const other = await one('SELECT id FROM users WHERE lower(email) = lower($1)', [data.email]);
    if (other && other.id !== userId) throw badRequest('error-field-unavailable', 'E-mail em uso.');
    sets.push(`email = $${params.push(data.email)}`, `email_verified = ${opts.asAdmin && data.verified ? 'true' : 'false'}`);
  }
  if (data.password) {
    // Na troca obrigatória (logo após entrar com a senha provisória) a senha atual não é pedida de novo.
    if (!opts.asAdmin && !(self && u.require_password_change)) {
      if (!getSetting('Accounts_AllowPasswordChange')) throw forbidden('Alteração de senha desativada.');
      if (u.password_hash && !(await verifyPassword(opts.currentPassword ?? '', u.password_hash))) throw badRequest('error-invalid-password', 'Senha atual incorreta.');
    }
    validatePassword(data.password);
    sets.push(`password_hash = $${params.push(await hashPassword(data.password))}`, 'require_password_change = false');
  }
  if (opts.asAdmin) {
    if (data.active !== undefined) {
      sets.push(`active = $${params.push(data.active)}`);
      // "Ativo" mudado à mão é decisão do administrador: a sincronização do LDAP só reativa o que ela mesma desativou.
      if (data.active !== u.active) sets.push('ldap_deactivated_at = NULL', 'ldap_deactivated_reason = NULL');
    }
    if (data.roles !== undefined) sets.push(`roles = $${params.push(data.roles.length ? data.roles : ['user'])}`);
    if (data.requirePasswordChange !== undefined) sets.push(`require_password_change = $${params.push(data.requirePasswordChange)}`);
    if (data.verified !== undefined && data.email === undefined) sets.push(`email_verified = $${params.push(data.verified)}`);
  }
  if (!sets.length) return u;
  sets.push('updated_at = now()');
  const row = await one(`UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  if (data.username && data.username !== u.username) await propagateUsername(userId, u.username, data.username);
  if (data.name !== undefined && data.name !== u.name) await query('UPDATE messages SET user_name = $2 WHERE user_id = $1', [userId, data.name]);
  if (data.active === false) {
    await revokeAllSessions(userId);
  }
  if (data.password && !self) await revokeAllSessions(userId);
  if (!self || data.roles || data.active !== undefined) {
    await audit(actorOf(actor), 'user.updated', { userId, username: row.username }, { fields: Object.keys(data).filter((k) => k !== 'password'), passwordChanged: !!data.password });
  }
  bus.publish({ all: true }, { type: 'user', action: 'updated', user: mapUser(row) });
  return row;
}

async function propagateUsername(userId: string, oldU: string, newU: string) {
  await query('UPDATE messages SET username = $2 WHERE user_id = $1', [userId, newU]);
  await query(
    `UPDATE rooms SET usernames = array_replace(usernames, $1, $2), fname = NULL WHERE t = 'd' AND $3 = ANY(uids)`,
    [oldU, newU, userId],
  );
}

export async function setPreferences(ctx: Ctx, prefs: UserPreferences) {
  const row = await one(`UPDATE users SET preferences = preferences || $2::jsonb, updated_at = now() WHERE id = $1 RETURNING *`, [ctx.userId, JSON.stringify(prefs)]);
  return row;
}

export async function setStatus(userId: string, status: UserStatus | undefined, statusText?: string) {
  const sets: string[] = [];
  const params: unknown[] = [userId];
  if (status) {
    sets.push(`status_default = $${params.push(status)}`);
    // Status real só muda se o usuário estiver conectado; offline continua offline.
    sets.push(`status = CASE WHEN EXISTS (SELECT 1 FROM presence_connections WHERE user_id = $1) THEN $${params.length} ELSE 'offline' END`);
  }
  if (statusText !== undefined) sets.push(`status_text = $${params.push(statusText.slice(0, 120))}`);
  if (!sets.length) return;
  const row = await one(`UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING id, username, status, status_text`, params);
  if (row) bus.publish({ all: true }, { type: 'presence', userId: row.id, username: row.username, status: row.status, statusText: row.status_text });
}

// Integrações (Jira/Teams): status passageiro (ex.: "Em reunião no Teams"). Muda status e status_text, nunca status_default,
// então a escolha da pessoa continua valendo quando ela reconecta ou volta de ausente (F10).
export async function setStatusTransient(userId: string, status: UserStatus | undefined, statusText?: string) {
  const sets: string[] = [];
  const params: unknown[] = [userId];
  if (status) sets.push(`status = CASE WHEN EXISTS (SELECT 1 FROM presence_connections WHERE user_id = $1) THEN $${params.push(status)} ELSE 'offline' END`);
  if (statusText !== undefined) sets.push(`status_text = $${params.push(statusText.slice(0, 120))}`);
  if (!sets.length) return;
  const row = await one(`UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING id, username, status, status_text`, params);
  if (row) bus.publish({ all: true }, { type: 'presence', userId: row.id, username: row.username, status: row.status, statusText: row.status_text });
}

export async function deleteUser(actor: Ctx, userId: string, opts: { confirmRelinquish?: boolean } = {}) {
  const u = await getUserById(userId);
  if (!u) throw notFound('error-invalid-user', 'Usuário não encontrado.');
  if (u.roles.includes('admin')) {
    const admins = await one(`SELECT count(*)::int AS n FROM users WHERE 'admin' = ANY(roles) AND active`);
    if (admins.n <= 1) throw badRequest('error-action-not-allowed', 'Não é possível remover o último administrador.');
  }
  await tx(async (c) => {
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
    await c.query(`DELETE FROM rooms WHERE t = 'd' AND $1 = ANY(uids)`, [userId]);
    const subs = await c.query('DELETE FROM subscriptions WHERE user_id = $1 RETURNING room_id', [userId]);
    for (const { room_id } of subs.rows) await c.query('UPDATE rooms SET users_count = GREATEST(users_count - 1, 0) WHERE id = $1', [room_id]);
    await c.query('DELETE FROM users WHERE id = $1', [userId]);
  });
  bus.forceLogout({ userId });
  await audit(actorOf(actor), 'user.deleted', { userId, username: u.username }, { relinquish: !!opts.confirmRelinquish });
}

// ---------- Avatar ----------

export async function setAvatar(userId: string, contentType: string, data: Buffer) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(contentType)) throw badRequest('error-invalid-image', 'Formato de imagem não suportado.');
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

export async function createPersonalToken(ctx: Ctx, name: string, bypass2fa: boolean) {
  const token = randomToken();
  if (await one('SELECT 1 FROM personal_access_tokens WHERE user_id = $1 AND name = $2', [ctx.userId, name]))
    throw badRequest('error-token-already-exists', 'Já existe um token com esse nome.');
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
  await query('DELETE FROM personal_access_tokens WHERE user_id = $1 AND name = $2', [userId, name]);
}

// ---------- Primeira execução ----------

export async function ensureAdmin(username: string, password: string | null, email: string, log: (m: string) => void) {
  const has = await one(`SELECT 1 FROM users WHERE 'admin' = ANY(roles) LIMIT 1`);
  if (has) return;
  const pw = password ?? randomToken(9);
  await createUser({ username, name: 'Administrador', email, password: pw, roles: ['admin', 'user'], verified: true, skipPasswordPolicy: true });
  log(`Administrador criado: usuário "${username}"${password ? '' : `, senha "${pw}" (troque após o primeiro login)`}`);
}
