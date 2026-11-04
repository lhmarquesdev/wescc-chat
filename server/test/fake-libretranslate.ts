import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFake, type FakeReply, type FakeRequest } from './fake-http';

// LibreTranslate falso para os testes da tradução (e para o roteiro do navegador, subido sozinho:
// `npx tsx server/test/fake-libretranslate.ts 3157`). Imita o que o chat usa do LibreTranslate de verdade:
// GET /languages, POST /detect, POST /translate (lista em q, origem explícita, format 'text'), GET /frontend/settings
// e os erros { "error": "…" } de chave da API. Nada sai para a internet.

export interface FakeLanguage {
  code: string;
  name: string;
  targets: string[];
}

export interface FakeLibre {
  url: string;
  host: string;
  calls: FakeRequest[]; // todas as chamadas, em ordem
  languages: FakeLanguage[]; // pode trocar no teste
  requireKey: string | null; // chave exigida em /detect e /translate (null = o servidor não pede)
  delayMs: number; // espera em /detect e /translate
  charLimit: number; // devolvido em /frontend/settings (-1 = sem limite)
  dictionary: Record<string, string>; // trecho → tradução (o resto vira "[origem>destino] trecho")
  // O próximo pedido (a /translate, a /detect, ou qualquer um sem path) recebe esta resposta.
  failNext(reply: FakeReply, path?: '/translate' | '/detect' | '/languages'): void;
  // Antes da resposta normal de /translate: devolva uma resposta para trocá-la (ex.: "exceeds text limit").
  translateHook: ((body: any) => FakeReply | undefined) | null;
  translateCalls(): any[]; // corpos recebidos em /translate
  detectCalls(): any[];
  reset(): void; // esquece as chamadas e volta ao padrão (idiomas, chave, espera, dicionário)
  close(): Promise<void>;
}

const NAMES: Record<string, string> = { en: 'English', es: 'Spanish', pt: 'Portuguese', 'pt-BR': 'Portuguese (Brazil)', de: 'German' };
export const defaultLanguages = (codes = ['en', 'es', 'pt', 'pt-BR', 'de']): FakeLanguage[] =>
  codes.map((code) => ({ code, name: NAMES[code] ?? code, targets: codes.filter((x) => x !== code) }));

// Frases do roteiro do navegador, para a tela mostrar inglês de verdade.
const DICTIONARY: Record<string, string> = {
  'Bom dia': 'Good morning',
  'Bom dia,': 'Good morning,',
  '! O deploy é hoje às 15h. Veja': '! The deploy is today at 3 pm. See',
  '! O deploy foi adiado para amanhã às 10h. Veja': '! The deploy was moved to tomorrow at 10 am. See',
  'Aviso importante': 'Important notice',
  'A reunião mudou para amanhã.': 'The meeting moved to tomorrow.',
  'Você pode revisar o relatório hoje?': 'Can you review the report today?',
  'Não esqueça de atualizar o painel hoje.': "Don't forget to update the dashboard today.",
  'Eu respondo no tópico: hoje não dá.': "I'll answer in the thread: today is not possible.",
  'Boa tarde, você viu o alerta de hoje?': 'Good afternoon, did you see today’s alert?',
  'Olá, o servidor voltou? Não consigo entrar hoje.': "Hello, is the server back? I can't log in today.",
};

const WORDS: [RegExp, string, number][] = [
  [/^(hello|the|good|please)$/, 'en', 95],
  [/^(hola|gracias|buenos)$/, 'es', 92],
  [/^(bom|boa|olá|você|não|hoje|reunião|aviso|amanhã)$/, 'pt', 96],
];

function detect(text: string): { language: string; confidence: number } {
  for (const w of String(text ?? '').toLowerCase().split(/[^\p{L}]+/u)) {
    for (const [re, language, confidence] of WORDS) if (re.test(w)) return { language, confidence };
  }
  return { language: 'en', confidence: 0 }; // como o LibreTranslate quando não sabe
}

export async function startFakeLibre(port = 0): Promise<FakeLibre> {
  const s = await startFake(port);
  const queued: { reply: FakeReply; path?: string }[] = [];
  const state = {
    languages: defaultLanguages(),
    requireKey: null as string | null,
    delayMs: 0,
    charLimit: -1,
    dictionary: { ...DICTIONARY } as Record<string, string>,
    translateHook: null as ((body: any) => FakeReply | undefined) | null,
  };
  const takeFailure = (p: string) => {
    const i = queued.findIndex((q) => !q.path || q.path === p);
    return i < 0 ? undefined : queued.splice(i, 1)[0].reply;
  };
  const keyProblem = (body: any): FakeReply | undefined => {
    if (!state.requireKey) return undefined;
    if (!body?.api_key) return { status: 400, body: { error: 'Please contact the server operator to get an API key' } };
    if (body.api_key !== state.requireKey) return { status: 403, body: { error: 'Invalid API key' } };
    return undefined;
  };

  // Qualquer prefixo de caminho também serve (um LibreTranslate atrás de um proxy em /tradutor; o roteiro do navegador usa
  // um prefixo novo a cada execução para o chat não reaproveitar a lista guardada).
  s.on('GET', /\/languages$/, () => takeFailure('/languages') ?? { body: state.languages });
  s.on('GET', /\/frontend\/settings$/, () => ({ body: { charLimit: state.charLimit, keyRequired: !!state.requireKey } }));
  s.on('POST', /\/detect$/, (req) => {
    const failed = takeFailure('/detect') ?? keyProblem(req.json);
    if (failed) return { delayMs: state.delayMs, ...failed };
    return { delayMs: state.delayMs, body: [detect(req.json?.q)] };
  });
  s.on('POST', /\/translate$/, (req) => {
    const body = req.json ?? {};
    const failed = takeFailure('/translate') ?? keyProblem(body);
    if (failed) return { delayMs: state.delayMs, ...failed };
    // Pega regressões: o chat sempre manda a origem e o formato texto.
    if (body.format !== 'text') return { status: 400, body: { error: 'Invalid request: format must be text in this fake' } };
    if (!body.source || body.source === 'auto') return { status: 400, body: { error: 'Invalid request: source auto is not allowed in this fake' } };
    const codes = state.languages.map((l) => l.code);
    if (!codes.includes(body.source)) return { status: 400, body: { error: `${body.source} is not supported` } };
    if (!codes.includes(body.target)) return { status: 400, body: { error: `${body.target} is not supported` } };
    const hooked = state.translateHook?.(body);
    if (hooked) return { delayMs: state.delayMs, ...hooked };
    const one = (q: string) => state.dictionary[q] ?? `[${body.source}>${body.target}] ${q}`;
    const translatedText = Array.isArray(body.q) ? body.q.map(one) : one(String(body.q ?? ''));
    return { delayMs: state.delayMs, body: { translatedText } };
  });

  const fake: FakeLibre = {
    url: s.url,
    host: s.host,
    calls: s.calls,
    get languages() {
      return state.languages;
    },
    set languages(v) {
      state.languages = v;
    },
    get requireKey() {
      return state.requireKey;
    },
    set requireKey(v) {
      state.requireKey = v;
    },
    get delayMs() {
      return state.delayMs;
    },
    set delayMs(v) {
      state.delayMs = v;
    },
    get charLimit() {
      return state.charLimit;
    },
    set charLimit(v) {
      state.charLimit = v;
    },
    get dictionary() {
      return state.dictionary;
    },
    set dictionary(v) {
      state.dictionary = v;
    },
    get translateHook() {
      return state.translateHook;
    },
    set translateHook(v) {
      state.translateHook = v;
    },
    failNext(reply, p) {
      queued.push({ reply, path: p });
    },
    translateCalls: () => s.calls.filter((c) => c.path === '/translate').map((c) => c.json),
    detectCalls: () => s.calls.filter((c) => c.path === '/detect').map((c) => c.json),
    reset() {
      s.calls.length = 0;
      queued.length = 0;
      state.languages = defaultLanguages();
      state.requireKey = null;
      state.delayMs = 0;
      state.charLimit = -1;
      state.dictionary = { ...DICTIONARY };
      state.translateHook = null;
    },
    close: () => s.close(),
  };
  return fake;
}

// Sozinho (roteiro do navegador): npx tsx server/test/fake-libretranslate.ts [porta]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? process.env.PORT ?? 5000);
  void startFakeLibre(port).then((f) => console.log(`LibreTranslate falso em ${f.url}`));
}
