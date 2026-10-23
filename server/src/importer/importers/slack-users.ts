import { ST, type ImportUser, type Importer, type PrepareContext } from '../types';
import { RowIssues, byteProgress, csvTable, isBlankRow, isEmail, openSingleCsv, semicolonError, semicolonSeparated } from './csv-util';

// Lista de membros exportada pelo Slack (Gerenciar membros → Exportar lista de membros). A primeira linha é o
// cabeçalho: username,email,status,billing-active,has-2fa,has-sso,userid,fullname,displayname,...

type Column = 'username' | 'email' | 'status' | 'fullname' | 'displayname';

const HEADER: Record<string, Column> = {
  username: 'username',
  'user name': 'username',
  email: 'email',
  'e-mail': 'email',
  status: 'status',
  'account type': 'status',
  fullname: 'fullname',
  'full name': 'fullname',
  displayname: 'displayname',
  'display name': 'displayname',
};
// Posições do arquivo do Slack, para um cabeçalho com outros nomes.
const POSITIONS: Record<Column, number> = { username: 0, email: 1, status: 2, fullname: 7, displayname: 8 };

const NO_EMAIL = ['linha sem e-mail válido ignorada', 'linhas sem e-mail válido ignoradas'] as const;
const REPEATED = ['e-mail repetido ignorado (vale a primeira linha)', 'e-mails repetidos ignorados (vale a primeira linha)'] as const;

function columnsOf(header: string[]): Partial<Record<Column, number>> | null {
  const named: Partial<Record<Column, number>> = {};
  header.forEach((h, i) => {
    const col = HEADER[h.trim().toLowerCase()];
    if (col) named[col] ??= i;
  });
  return named.email === undefined ? null : named;
}

// Tipo de conta do Slack. Donos do workspace também viram administradores, como no importador do Slack.
function applyStatus(rec: ImportUser, status: string) {
  const s = status.trim().toLowerCase();
  if (s === 'admin' || s === 'owner' || s === 'primary owner') rec.roles = ['admin'];
  else if (s === 'bot') rec.type = 'bot';
  else if (s === 'deactivated') rec.deleted = true;
}

async function prepare(ctx: PrepareContext) {
  const { name: file, size, stream } = await openSingleCsv(ctx);
  await ctx.setStep(ST.preparingUsers);
  ctx.progress(0);
  const issues = new RowIssues();
  const seen = new Set<string>();
  let cols: Partial<Record<Column, number>> | null = null;
  let staged = 0;
  for await (const row of csvTable(stream, file, { warn: (m) => ctx.warn(m), onBytes: byteProgress(ctx, size) })) {
    if (ctx.cancelled()) return;
    if (isBlankRow(row.fields)) continue;
    if (!cols) {
      if (semicolonSeparated(row.fields, 3)) throw semicolonError(file);
      const named = columnsOf(row.fields);
      cols = named ?? POSITIONS;
      if (named || !row.fields[POSITIONS.email]?.includes('@')) continue;
      // Sem cabeçalho: a primeira linha já é um usuário e não pode se perder.
      ctx.warn(`"${file}" não tem a linha de cabeçalho; a primeira linha foi lida como um usuário.`);
    }
    const c = cols;
    const get = (k: Column) => (c[k] === undefined ? '' : (row.fields[c[k]] ?? '').trim());
    // O e-mail é o id da pessoa: "-", "n/a" e afins não são e-mail, e virariam o mesmo id para pessoas diferentes.
    const email = get('email');
    if (!isEmail(email)) {
      issues.add(NO_EMAIL, row.line);
      continue;
    }
    if (seen.has(email.toLowerCase())) {
      issues.add(REPEATED, row.line);
      continue;
    }
    seen.add(email.toLowerCase());
    const username = get('username');
    const rec: ImportUser = { importIds: [email], emails: [email] };
    if (username) rec.username = username;
    const name = get('fullname') || get('displayname') || username;
    if (name) rec.name = name;
    applyStatus(rec, get('status'));
    await ctx.user(rec);
    staged++;
  }
  if (!cols) return ctx.warn(`"${file}" está vazio.`);
  issues.flush((m) => ctx.warn(m), file);
  if (!staged) ctx.warn(`Nenhum usuário com e-mail em "${file}".`);
  ctx.progress(100);
}

export const slackUsersImporter: Importer = {
  key: 'slack-users',
  name: 'Usuários do Slack',
  label: 'Usuários do Slack (.csv)',
  description:
    'A lista de membros exportada pelo Slack (Gerenciar membros › Exportar lista de membros). Cria as contas sem canais nem mensagens; administradores, bots e contas desativadas são mantidos.',
  accept: '.csv',
  sourceKind: 'file',
  visible: true,
  prepare,
};
