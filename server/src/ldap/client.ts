import { Client, type Entry } from 'ldapts';
import { rdnValue, type LdapGroupRef } from '@shared/ldap';
import type { LdapConfig } from './config';
import { applyNestedGroups, usesNestedGroups } from './mapping';

// Acesso ao diretório (ldapts): conexão, busca de usuários e grupos e leitura dos atributos.

export function escapeFilter(v: string) {
  return v.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

// Aceita o filtro com ou sem os parênteses de fora.
const wrapFilter = (f: string) => (f.startsWith('(') ? f : `(${f})`);

export function openClient(cfg: LdapConfig) {
  if (!/^ldaps?:\/\/./i.test(cfg.url)) throw new Error(`URL do servidor LDAP inválida: "${cfg.url}" (use ldap:// ou ldaps://).`);
  const secure = /^ldaps:/i.test(cfg.url);
  return new Client({
    url: cfg.url,
    timeout: 10_000,
    connectTimeout: 10_000,
    // Só no ldaps://: o ldapts abre TLS sempre que recebe tlsOptions, e o AD derruba o TLS na porta 389.
    // A CA nas configurações permite confiar numa AD CS interna sem NODE_EXTRA_CA_CERTS.
    tlsOptions: secure ? { rejectUnauthorized: cfg.rejectUnauthorized, ca: cfg.caPem ? [cfg.caPem] : undefined } : undefined,
  });
}

const TLS_CODES = /CERT|SELF_SIGNED|UNABLE_TO_|ERR_TLS|ERR_SSL|EPROTO/;
// Recusa do usuário de serviço (código LDAP 49 no bind dele): marcada para o texto dizer quem foi recusado.
const SERVICE_BIND_REFUSED = 'LDAP_SERVICE_BIND_REFUSED';

// Texto em português para os erros mais comuns, mantendo a mensagem original entre parênteses.
export function ldapErrorText(e: unknown): string {
  const err = e as { message?: string; code?: unknown };
  const msg = String(err?.message ?? e);
  const code = err?.code;
  if (code === SERVICE_BIND_REFUSED) return `o usuário de serviço foi recusado pelo servidor LDAP (${msg})`;
  if (code === 49) return `usuário ou senha recusados pelo servidor LDAP (${msg})`;
  if (code === 'ECONNREFUSED') return `conexão recusada pelo servidor LDAP (${msg})`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `servidor LDAP não encontrado (${msg})`;
  if (code === 'ETIMEDOUT' || /timeout|timed out/i.test(msg)) return `o servidor LDAP não respondeu a tempo (${msg})`;
  if ((typeof code === 'string' && TLS_CODES.test(code)) || /certificate|self.signed|SSL|TLS/i.test(msg)) return `certificado do servidor LDAP não aceito (${msg})`;
  return msg;
}

export async function bindService(client: Client, cfg: LdapConfig) {
  if (!cfg.bindDn) return;
  try {
    await client.bind(cfg.bindDn, cfg.bindPassword);
  } catch (e: any) {
    // Só a mensagem original: o texto em português fica com ldapErrorText (senão sai traduzido duas vezes).
    if (e?.code === 49) throw Object.assign(new Error(String(e.message ?? e)), { code: SERVICE_BIND_REFUSED, ldapCode: 49 });
    throw e;
  }
}

const unique = (list: string[]) => [...new Set(list)];

// Atributos pedidos nas buscas de usuários: só o que a sincronização usa (as fotos só com a opção ligada).
export function userAttributes(cfg: LdapConfig) {
  return unique([
    ...cfg.usernameFields,
    ...cfg.nameFields,
    ...cfg.emailFields,
    ...cfg.uidFields,
    ...cfg.loginFields,
    ...(cfg.syncAvatar ? cfg.avatarFields : []),
    'objectClass',
    'userAccountControl',
  ]);
}

// Binários sempre como Buffer (sem isso o ldapts tenta ler como UTF-8 e às vezes consegue).
export function bufferAttributes(cfg: LdapConfig) {
  const names = ['objectGUID', 'objectSid', ...cfg.avatarFields];
  return unique(names.flatMap((n) => [n, n.toLowerCase()]));
}

export function entryValues(entry: Entry, name: string): (string | Buffer)[] {
  let v: Entry[string] | undefined = entry[name];
  if (v === undefined) {
    const key = Object.keys(entry).find((k) => k.toLowerCase() === name.toLowerCase());
    v = key ? entry[key] : undefined;
  }
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]) as (string | Buffer)[];
}

// Primeiro valor não vazio entre os atributos (Buffer vira hex, como sempre foi gravado).
export function entryAttr(entry: Entry, names: string | string[]): string | undefined {
  const list = typeof names === 'string' ? names.split(',').map((s) => s.trim()).filter(Boolean) : names;
  for (const n of list) {
    const first = entryValues(entry, n)[0];
    if (first === undefined) continue;
    if (Buffer.isBuffer(first)) {
      if (first.length) return first.toString('hex');
      continue;
    }
    if (first !== '') return String(first);
  }
  return undefined;
}

function rawUid(entry: Entry, cfg: LdapConfig): string | Buffer | undefined {
  for (const n of cfg.uidFields) {
    const first = entryValues(entry, n)[0];
    if (Buffer.isBuffer(first) ? first.length : first) return first;
  }
  return undefined;
}

// Identificador estável da entrada: o primeiro campo de identificador único, ou o DN.
export function entryUid(entry: Entry, cfg: LdapConfig): string {
  const v = rawUid(entry, cfg);
  if (Buffer.isBuffer(v)) return v.toString('hex');
  return v ?? entry.dn;
}

// Formas antigas do mesmo identificador, para achar contas gravadas antes: o GUID lido como texto
// (quando os bytes eram UTF-8 válido) e o DN (quando não havia identificador).
export function legacyUids(entry: Entry, cfg: LdapConfig): string[] {
  const v = rawUid(entry, cfg);
  const out: string[] = [];
  if (Buffer.isBuffer(v)) {
    // Só existia em texto quando os bytes eram UTF-8 válido (e sem \0, que o PostgreSQL não guarda).
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(v);
      if (!text.includes('\0')) out.push(text);
    } catch {
      // bytes que não são UTF-8: sempre foram gravados em hex
    }
  }
  out.push(entry.dn);
  const uid = entryUid(entry, cfg);
  return unique(out).filter((x) => x && x !== uid);
}

// Forma canônica do objectGUID (a que o AD mostra): os três primeiros blocos ficam em little-endian.
export function guidString(buf: Buffer): string {
  if (buf.length !== 16) return buf.toString('hex');
  const h = (from: number, to: number, rev = false) => {
    const part = [...buf.subarray(from, to)];
    if (rev) part.reverse();
    return Buffer.from(part).toString('hex');
  };
  return `${h(0, 4, true)}-${h(4, 6, true)}-${h(6, 8, true)}-${h(8, 10)}-${h(10, 16)}`;
}

export function entryGuid(entry: Entry): string | undefined {
  const v = entryValues(entry, 'objectGUID')[0];
  return Buffer.isBuffer(v) && v.length === 16 ? guidString(v) : undefined;
}

// userAccountControl com o bit ACCOUNTDISABLE (2).
export function isAccountDisabled(entry: Entry): boolean {
  return (Number(entryAttr(entry, 'userAccountControl') ?? 0) & 2) !== 0;
}

const NOT_PEOPLE = new Set(['group', 'organizationalunit', 'container', 'computer']);

// Grupos, OUs, contêineres e computadores nunca viram usuários (o filtro padrão devolve tudo).
export function isPersonEntry(entry: Entry): boolean {
  return !entryValues(entry, 'objectClass').some((c) => NOT_PEOPLE.has(String(c).toLowerCase()));
}

// Entradas de pessoas que correspondem ao login (todas: mais de uma recusa o login).
export async function findEntries(client: Client, cfg: LdapConfig, login: string): Promise<Entry[]> {
  const fields = cfg.loginFields.length ? cfg.loginFields : cfg.usernameFields;
  if (!fields.length) throw new Error('Configure o campo de busca do login (LDAP_User_Search_Field).');
  const v = escapeFilter(login);
  const byLogin = fields.length > 1 ? `(|${fields.map((f) => `(${f}=${v})`).join('')})` : `(${fields[0]}=${v})`;
  const { searchEntries } = await client.search(cfg.baseDn, {
    scope: 'sub',
    filter: `(&${wrapFilter(cfg.userFilter)}${byLogin})`,
    attributes: userAttributes(cfg),
    explicitBufferAttributes: bufferAttributes(cfg),
  });
  return searchEntries.filter(isPersonEntry);
}

// Todas as entradas do filtro de usuários, página por página (memória limitada mesmo com fotos).
export async function* userPages(client: Client, cfg: LdapConfig): AsyncGenerator<Entry[]> {
  const pages = client.searchPaginated(cfg.baseDn, {
    scope: 'sub',
    filter: wrapFilter(cfg.userFilter),
    attributes: userAttributes(cfg),
    explicitBufferAttributes: bufferAttributes(cfg),
    paged: { pageSize: 200 },
  });
  for await (const page of pages) yield page.searchEntries;
}

// Modelo do filtro de grupos já com a opção de grupos aninhados aplicada.
export function groupFilterTemplate(cfg: LdapConfig): { template: string; nestedApplied: boolean; warning?: string } {
  if (!cfg.groupFilter) return { template: '', nestedApplied: false };
  if (!cfg.groupNested) return { template: cfg.groupFilter, nestedApplied: usesNestedGroups(cfg.groupFilter) };
  const r = applyNestedGroups(cfg.groupFilter);
  return {
    template: r.filter,
    nestedApplied: r.applied,
    warning: r.applied ? undefined : 'O filtro de grupos não tem (member=#{userdn}); a opção de grupos aninhados não foi aplicada.',
  };
}

function groupRef(g: Entry): LdapGroupRef {
  const ref: LdapGroupRef = { dn: g.dn, cn: entryAttr(g, 'cn') ?? rdnValue(g.dn) };
  const sam = entryAttr(g, 'sAMAccountName');
  if (sam) ref.sAMAccountName = sam;
  return ref;
}

// Grupos do usuário. Lança o erro quando a busca falha (quem chama decide o que fazer).
export async function groupsOf(client: Client, cfg: LdapConfig, entry: Entry): Promise<LdapGroupRef[]> {
  const { template } = groupFilterTemplate(cfg);
  if (!template) return [];
  const values: Record<string, string> = { userdn: entry.dn, username: entryAttr(entry, cfg.usernameFields) ?? '' };
  // Uma passada só, com função: o texto colocado não é lido de novo como modelo (um DN com "#{username}")
  // nem como texto de substituição ("$'", "$&" e "$$").
  const filter = wrapFilter(template.replace(/#\{(userdn|username)\}/gi, (_m, k: string) => escapeFilter(values[k.toLowerCase()])));
  const { searchEntries } = await client.search(cfg.groupBaseDn, { scope: 'sub', filter, attributes: ['cn', 'sAMAccountName'], paged: { pageSize: 500 } });
  return searchEntries.map(groupRef);
}

// Grupos da base de grupos com estes nomes (cn ou sAMAccountName): mostra quando o nome de uma regra serve para
// mais de um grupo (no AD o cn só é único dentro da OU).
export async function groupsNamed(client: Client, cfg: LdapConfig, names: string[]): Promise<LdapGroupRef[]> {
  if (!names.length) return [];
  const byName = names.map((n) => `(cn=${escapeFilter(n)})(sAMAccountName=${escapeFilter(n)})`).join('');
  const filter = `(&(|(objectClass=group)(objectClass=groupOfNames)(objectClass=groupOfUniqueNames)(objectClass=posixGroup))(|${byName}))`;
  const { searchEntries } = await client.search(cfg.groupBaseDn, { scope: 'sub', filter, attributes: ['cn', 'sAMAccountName'], paged: { pageSize: 500 } });
  return searchEntries.map(groupRef);
}
