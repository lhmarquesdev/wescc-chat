// Chaves e links de issue num texto (puro).

// Chave solta: projeto em maiúsculas + número, sem fazer parte de uma palavra, caminho, e-mail ou outra chave.
const BARE_KEY = /(?<![\w/@.-])([A-Z][A-Z0-9_]{1,19})-([1-9]\d{0,6})(?![\w-])/g;
const EXACT_KEY = /^([A-Z][A-Z0-9_]{1,19})-([1-9]\d{0,6})$/;
const URL_RE = /https?:\/\/[^\s<>()[\]"'`]+/gi;
const EMAIL_RE = /[^\s@<>()[\]"'`]+@[^\s@<>()[\]"'`]+/g;
const FENCED = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]*`/g;

export function isIssueKey(s: string): boolean {
  return EXACT_KEY.test(s);
}

export function projectOfKey(key: string): string {
  return key.slice(0, key.lastIndexOf('-'));
}

// Troca por espaços (mesmo tamanho): as posições do resto do texto não mudam, e nada se junta a uma chave vizinha.
const blank = (s: string) => ' '.repeat(s.length);

// Chave de um link do próprio site: /browse/OPS-1 ou ?selectedIssue=OPS-1.
function keyFromUrl(raw: string, siteHost: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.replace(/[.,;:!?]+$/, ''));
  } catch {
    return null;
  }
  if (u.host.toLowerCase() !== siteHost.toLowerCase()) return null;
  const browse = /^\/browse\/([^/?#]+)\/?$/.exec(u.pathname)?.[1];
  if (browse && isIssueKey(browse)) return browse;
  const selected = u.searchParams.get('selectedIssue');
  if (selected && isIssueKey(selected)) return selected;
  return null;
}

// Chaves citadas, na ordem em que aparecem, sem repetir, no máximo `max`. Código (``` e `) não conta;
// links só do site configurado; tudo só dos projetos listados.
export function extractIssueRefs(text: string, o: { siteHost: string | null; projects: string[]; max: number }): string[] {
  if (!text || o.max <= 0 || !o.projects.length) return [];
  const projects = new Set(o.projects.map((p) => p.toUpperCase()));
  let s = text.replace(FENCED, blank).replace(INLINE_CODE, blank);
  const found: { at: number; key: string }[] = [];
  s = s.replace(URL_RE, (m, at: number) => {
    const key = o.siteHost ? keyFromUrl(m, o.siteHost) : null;
    if (key) found.push({ at, key });
    return blank(m);
  });
  s = s.replace(EMAIL_RE, blank);
  for (const m of s.matchAll(BARE_KEY)) found.push({ at: m.index ?? 0, key: m[0] });
  found.sort((a, b) => a.at - b.at);
  const out: string[] = [];
  for (const f of found) {
    if (!projects.has(projectOfKey(f.key)) || out.includes(f.key)) continue;
    out.push(f.key);
    if (out.length >= o.max) break;
  }
  return out;
}
