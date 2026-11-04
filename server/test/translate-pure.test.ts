import { describe, expect, it } from 'vitest';
import { CHANNEL_SRC, CODE_SRC, EMOJI_SRC, MD_LINK_SRC, MENTION_SRC, URL_SRC } from '@shared/markdownTokens';
import {
  baseLang,
  cleanRun,
  hasTextToTranslate,
  joinTranslation,
  letterCount,
  normalizeLang,
  pickLanguage,
  runsOf,
  sameLanguage,
  splitForTranslation,
  targetFor,
  translatableMessage,
  translateUrlCheck,
  TRANSLATE_MAX_RUNS,
} from '@shared/translate';

// Tradução de mensagens: regras puras de shared/src/translate.ts (trechos, idiomas, endereço, o que nunca traduz).

const CORPUS = [
  'Bom dia, @ana! Veja `npm test` em https://x.example/a :smile:',
  '```\nconst a = 1;\n```\nDepois do bloco.',
  'Antes ```js\nsem fechamento\nainda código',
  '> citação\n> > aninhada com @bruno.\nfora da citação',
  '- item um\n* item dois\n• item três',
  '# Título do aviso\nA reunião mudou para amanhã.',
  '## Subtítulo com #canal-geral e #operação.',
  'Fale com @nome. Ele sabe.',
  '[o manual](https://wiki.example/manual) e (veja https://x.example/a_(b)) também',
  '   espaços nas pontas   ',
  '*negrito nas pontas*',
  '**muito** _itálico_ ~tachado~ no meio',
  ':thumbsup: :tada:',
  '👍👍',
  'linha um\r\nlinha dois\rlinha três',
  '',
  '\n\n',
  'www.example.com/caminho?x=1 no começo',
  '@ana @bruno',
  'texto com `código` e mais `outro código` no fim',
  '> # título citado\n> - item citado',
];

const KEEP = new RegExp([CODE_SRC, MD_LINK_SRC, URL_SRC, MENTION_SRC, CHANNEL_SRC, EMOJI_SRC].map((s) => `(?:${s})`).join('|'));

describe('trechos (splitForTranslation, joinTranslation)', () => {
  it('ida e volta exata em qualquer texto', () => {
    for (const msg of CORPUS) {
      const p = splitForTranslation(msg)!;
      expect(p, msg).not.toBeNull();
      expect(joinTranslation(p, runsOf(p)), msg).toBe(msg.replace(/\r\n?/g, '\n'));
    }
  });

  it('nenhum trecho levado ao tradutor tem código, link, menção, canal ou emoji', () => {
    for (const msg of CORPUS) {
      for (const run of runsOf(splitForTranslation(msg)!)) {
        expect(KEEP.test(run), `${msg} → ${run}`).toBe(false);
        expect(run).toBe(run.trim());
        expect(/\p{L}/u.test(run)).toBe(true);
        expect(run).not.toMatch(/^[*_~]|[*_~]$/);
      }
    }
  });

  it('corta em volta dos tokens e mantém a marcação do começo da linha', () => {
    const p = splitForTranslation('Bom dia, @ana! Veja `npm test` em https://x.example/a :smile:')!;
    // Só espaços e marcas de ênfase das pontas ficam de fora; a pontuação vai junto com o texto.
    expect(runsOf(p)).toEqual(['Bom dia,', '! Veja', 'em']);
  });

  it('trecho sem letra (pontuação, números) fica com os pedaços que não vão ao tradutor', () => {
    expect(runsOf(splitForTranslation('Bom dia, @ana! :smile: Veja')!)).toEqual(['Bom dia,', 'Veja']);
    expect(runsOf(splitForTranslation('# Título\n> > dentro\n- item')!)).toEqual(['Título', 'dentro', 'item']);
    expect(runsOf(splitForTranslation('```\nnada aqui\n```')!)).toEqual([]);
    expect(runsOf(splitForTranslation('*negrito nas pontas*')!)).toEqual(['negrito nas pontas']);
    expect(runsOf(splitForTranslation('12:30 - 45%')!)).toEqual([]);
  });

  it('a tradução remontada mantém tokens e marcação', () => {
    const p = splitForTranslation('# Aviso importante\nFale com @ana. Veja `npm run build`.')!;
    const out = joinTranslation(p, runsOf(p).map((r) => r.toUpperCase()));
    expect(out).toBe('# AVISO IMPORTANTE\nFALE COM @ana. VEJA `npm run build`.');
  });

  it(`mais de ${TRANSLATE_MAX_RUNS} trechos de texto → null`, () => {
    const many = Array.from({ length: TRANSLATE_MAX_RUNS + 1 }, (_, i) => `palavra${i}`).join(' @x ');
    expect(splitForTranslation(many)).toBeNull();
    const ok = Array.from({ length: TRANSLATE_MAX_RUNS }, (_, i) => `palavra${i}`).join(' @x ');
    expect(runsOf(splitForTranslation(ok)!)).toHaveLength(TRANSLATE_MAX_RUNS);
  });

  it('conta as letras dos trechos (só emoji, menção, link ou código: zero)', () => {
    expect(letterCount(splitForTranslation('👍👍 @ana https://x.example `x`')!)).toBe(0);
    expect(letterCount(splitForTranslation('ok')!)).toBe(2);
    expect(letterCount(splitForTranslation('Bom dia')!)).toBe(6);
  });

  it('hasTextToTranslate: só emoji, menção, link ou código não tem o que traduzir', () => {
    for (const msg of [':smile: :tada:', '👍👍', '@ana @bruno', 'https://x.example/a', '`npm test`', '```\nconst a = 1;\n```', 'ok', '#geral', '12:30']) {
      expect(hasTextToTranslate(msg), msg).toBe(false);
    }
    for (const msg of ['Bom dia', ':smile: Good morning', '@ana veja isto', '# Aviso\nA reunião mudou.']) expect(hasTextToTranslate(msg), msg).toBe(true);
    // Trechos demais: o servidor responde que é longa demais (a pessoa vê o motivo).
    expect(hasTextToTranslate(Array.from({ length: TRANSLATE_MAX_RUNS + 1 }, (_, i) => `palavra${i}`).join(' @x '))).toBe(true);
  });

  // Revisão: /[\s*_~]+$/ recomeçava de cada posição de uma sequência longa (5.000 '*' → ~50 ms por mensagem; 50 por
  // pedido seguravam o servidor mais de 1 s). O corte agora é linear.
  it('sequências longas de marcas e espaços: linear (50 mensagens de 5.000 caracteres em dezenas de ms)', () => {
    const fill = ['*', '_', '~', ' ', ' *_~', '\t', '[', '`', ':', '@', '#', '>', '`a', '[a](', 'www.', '- '];
    const msgs = Array.from({ length: 50 }, (_, i) => {
      const f = fill[i % fill.length];
      const head = 'hello the good ';
      return head + f.repeat(Math.ceil(5000 / f.length)).slice(0, 5000 - head.length - 1) + 'x';
    });
    splitForTranslation(msgs[0]); // aquece o JIT
    const t = performance.now();
    for (const m of msgs) splitForTranslation(m);
    expect(performance.now() - t).toBeLessThan(150);
    // E o corte continua o mesmo: as marcas das pontas ficam fora do trecho, a ida e volta é exata.
    const p = splitForTranslation(`**hello ${'*'.repeat(3000)}x  ***`)!;
    expect(runsOf(p)).toEqual([`hello ${'*'.repeat(3000)}x`]);
    expect(p[p.length - 1]).toEqual({ k: '  ***' });
    expect(joinTranslation(p, runsOf(p))).toBe(`**hello ${'*'.repeat(3000)}x  ***`);
    expect(runsOf(splitForTranslation(`_~ Bom dia ~_ ${' '.repeat(4000)}`)!)).toEqual(['Bom dia']);
  });
});

describe('saída do tradutor (cleanRun)', () => {
  it('uma linha, sem bloco de código nem link novo', () => {
    expect(cleanRun('Bom dia', '  Good\nmorning \n')).toBe('Good morning');
    const evil = cleanRun('Veja o manual', 'See ```rm -rf``` at https://evil.example and [x](https://evil.example) www.evil.example')!;
    expect(evil).not.toContain('```');
    expect(evil).not.toMatch(/https?:\/\//);
    expect(evil).not.toContain('](');
    expect(evil).not.toContain('www.');
    expect(evil).toContain('​');
    expect(cleanRun('abc', '``````')).not.toContain('```');
  });

  it('vazia ou 4 vezes maior que o original → null', () => {
    expect(cleanRun('Bom dia', '   ')).toBeNull();
    expect(cleanRun('Oi', 'x'.repeat(2 * 4 + 51))).toBeNull();
    expect(cleanRun('Oi', 'x'.repeat(2 * 4 + 50))).not.toBeNull();
  });
});

describe('idiomas', () => {
  it('normalizeLang e baseLang', () => {
    expect(normalizeLang('pt-br')).toBe('pt-BR');
    expect(normalizeLang('PT_br')).toBe('pt-BR');
    expect(normalizeLang('zh-hans')).toBe('zh-Hans');
    expect(normalizeLang('pb')).toBe('pt-BR');
    expect(normalizeLang('zt')).toBe('zh-Hant');
    expect(normalizeLang('zh')).toBe('zh-Hans');
    expect(normalizeLang('EN')).toBe('en');
    expect(baseLang('pt-BR')).toBe('pt');
    expect(baseLang('pb')).toBe('pt');
  });

  it('sameLanguage: pt e pt-BR são o mesmo; chinês simplificado e tradicional não', () => {
    expect(sameLanguage('pt', 'pt-BR')).toBe(true);
    expect(sameLanguage('pb', 'pt')).toBe(true);
    expect(sameLanguage('en-US', 'en')).toBe(true);
    expect(sameLanguage('zh-Hans', 'zh-Hant')).toBe(false);
    expect(sameLanguage('zh', 'zh-Hans')).toBe(true);
    expect(sameLanguage('en', 'es')).toBe(false);
  });

  it('pickLanguage devolve o código como está na lista', () => {
    expect(pickLanguage('pt-BR', ['en', 'pt'])).toBe('pt');
    expect(pickLanguage('pt', ['en', 'pt-BR'])).toBe('pt-BR');
    expect(pickLanguage('pt-br', ['pt', 'pt-BR'])).toBe('pt-BR');
    expect(pickLanguage('pt-PT', ['pt-BR', 'pt'])).toBe('pt');
    expect(pickLanguage('en-US', ['en', 'es'])).toBe('en');
    expect(pickLanguage('zh-Hant', ['zh-Hans'])).toBe('zh-Hans');
    expect(pickLanguage('pb', ['pt'])).toBe('pt');
    expect(pickLanguage('de', ['en', 'pt'])).toBeNull();
  });

  it('targetFor: idioma da sala, depois o da pessoa, depois o da empresa', () => {
    expect(targetFor({ sub: { autoTranslateLanguage: 'es' }, prefs: { language: 'en' }, siteLanguage: 'pt-BR' })).toBe('es');
    expect(targetFor({ sub: { autoTranslateLanguage: null }, prefs: { language: 'en' }, siteLanguage: 'pt-BR' })).toBe('en');
    expect(targetFor({ sub: null, prefs: {}, siteLanguage: 'es' })).toBe('es');
    expect(targetFor({ prefs: { language: 42 } })).toBe('pt-BR');
    expect(targetFor({})).toBe('pt-BR');
  });
});

describe('endereço do LibreTranslate (translateUrlCheck)', () => {
  it('só o que está em INTEGRATIONS_ALLOWED_HOSTS, como o safeFetch', () => {
    expect(translateUrlCheck('http://10.0.0.20:5000', ['10.0.0.20:5000'])).toEqual({ base: 'http://10.0.0.20:5000', hostPort: '10.0.0.20:5000' });
    expect(translateUrlCheck('http://10.0.0.20:5000', ['10.0.0.20'])).toEqual({ problem: 'Libere "10.0.0.20:5000" em INTEGRATIONS_ALLOWED_HOSTS no servidor do chat e reinicie o serviço.' });
    expect(translateUrlCheck('https://lt.empresa', ['lt.empresa'])).toEqual({ base: 'https://lt.empresa', hostPort: 'lt.empresa:443' });
    expect('problem' in translateUrlCheck('http://lt.empresa', ['lt.empresa'])).toBe(true);
    expect(translateUrlCheck('http://lt.empresa', ['lt.empresa:80'])).toEqual({ base: 'http://lt.empresa', hostPort: 'lt.empresa:80' });
    expect('problem' in translateUrlCheck('https://lt.empresa:8443', ['lt.empresa'])).toBe(true);
  });

  it('IP da internet: o aviso é o da rede da empresa, antes do de INTEGRATIONS_ALLOWED_HOSTS', () => {
    const isExternal = (h: string) => h === '8.8.8.8' || h === '2001:4860:4860::8888';
    expect(translateUrlCheck('http://8.8.8.8:5000', [], isExternal)).toEqual({
      problem: 'O servidor de tradução precisa estar na rede da empresa: 8.8.8.8 é um endereço da internet. O texto das mensagens não pode sair da empresa.',
      external: true,
    });
    expect(translateUrlCheck('http://8.8.8.8:5000', ['8.8.8.8:5000'], isExternal)).toMatchObject({ external: true });
    expect(translateUrlCheck('http://[2001:4860:4860::8888]:5000', [], isExternal)).toMatchObject({ external: true });
    expect(translateUrlCheck('http://10.0.0.20:5000', ['10.0.0.20:5000'], isExternal)).toEqual({ base: 'http://10.0.0.20:5000', hostPort: '10.0.0.20:5000' });
    expect(translateUrlCheck('http://10.0.0.20:5000', [], isExternal)).toEqual({ problem: 'Libere "10.0.0.20:5000" em INTEGRATIONS_ALLOWED_HOSTS no servidor do chat e reinicie o serviço.' });
  });

  it('recusa usuário, senha, parâmetros e outros protocolos; o caminho vira base sem a barra', () => {
    const ok = ['10.0.0.20:5000'];
    const only = 'Informe só o endereço do servidor, sem usuário, senha ou parâmetros.';
    expect(translateUrlCheck('http://u:p@10.0.0.20:5000', ok)).toEqual({ problem: only });
    expect(translateUrlCheck('http://10.0.0.20:5000/?a=1', ok)).toEqual({ problem: only });
    expect(translateUrlCheck('http://10.0.0.20:5000/?', ok)).toEqual({ problem: only });
    expect(translateUrlCheck('http://10.0.0.20:5000/#x', ok)).toEqual({ problem: only });
    expect(translateUrlCheck('ftp://10.0.0.20:5000', ok)).toEqual({ problem: 'Use http:// ou https://.' });
    expect(translateUrlCheck('não é url', ok)).toEqual({ problem: 'Endereço inválido. Exemplo: http://10.0.0.20:5000' });
    expect(translateUrlCheck(' http://10.0.0.20:5000/tradutor/ ', ok)).toEqual({ base: 'http://10.0.0.20:5000/tradutor', hostPort: '10.0.0.20:5000' });
  });
});

describe('o que nunca é traduzido (translatableMessage)', () => {
  it('sala criptografada, mensagem cifrada, sistema, figurinha, enquete, encaminhada e vazia', () => {
    const m = { msg: 'Bom dia' };
    expect(translatableMessage(null, m)).toBe(true);
    expect(translatableMessage({ encrypted: false }, m)).toBe(true);
    expect(translatableMessage({ encrypted: true }, m)).toBe(false);
    expect(translatableMessage(null, { ...m, e2e: { ciphertext: 'x' } })).toBe(false);
    expect(translatableMessage(null, { ...m, e2e: null })).toBe(true);
    expect(translatableMessage(null, { ...m, t: 'rm' })).toBe(false);
    expect(translatableMessage(null, { ...m, t: 'uj' })).toBe(false);
    expect(translatableMessage(null, { ...m, sticker: { fileId: 'f' } })).toBe(false);
    expect(translatableMessage(null, { ...m, poll: { question: 'q' } })).toBe(false);
    expect(translatableMessage(null, { ...m, forward: { mid: 'x' } })).toBe(false);
    expect(translatableMessage(null, { msg: '  ' })).toBe(false);
    expect(translatableMessage(null, {})).toBe(false);
    expect(translatableMessage(null, null)).toBe(false);
  });
});
