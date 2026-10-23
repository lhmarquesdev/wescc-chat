import { describe, expect, it } from 'vitest';
import { FLOW_AUDIENCE } from '../src/integrations/endpoints';
import { budgetKey, BUDGET_WINDOW_MS, localDay, takeFrom } from '../src/integrations/msteams/budget';
import { buildCard, buildDigestCard, CARD_MAX_BYTES, cardBytes, chatMarkdownToCard, digestTitle, hhmm, type CardInput } from '../src/integrations/msteams/cards';
import { FLOW_SCOPE, GRAPH_TEXT, odataQuote, retryAfterMs, tokenClaims, tokenError } from '../src/integrations/msteams/graph';
import { HTML_TEXT, htmlIsBlank, safeName, teamsHtmlToMarkdown, teamsMessageText } from '../src/integrations/msteams/html';
import { parseMessageResource } from '../src/integrations/msteams/notifications';
import { OUT_TEXT, workflowsUrlProblem } from '../src/integrations/msteams/outgoing';
import { idsOfResource, presenceResource } from '../src/integrations/msteams/presence';
import { safeExternalText, trustedLinkHost } from '../src/integrations/text';
import { normalizeTeamsMeetingUrl, teamsPresenceLabel, teamsScheduleLink } from '@shared/integrations';

// Partes puras do Teams (§5, §12.3): HTML do Teams → markdown do chat, cartões, links de reunião, limite de posts,
// endereços do Workflows e erros do Entra. Nada de banco nem de rede.

const ZW = '​';
const o = { trustedHost: trustedLinkHost, safeText: safeExternalText, max: 5000 };
const md = (html: string) => teamsHtmlToMarkdown(html, o);

// Espelho de inline() em web/src/lib/markdown.tsx: os endereços que a tela do chat transformaria em link e as menções
// de grupo que ela destacaria. Código fica de fora; negrito, itálico e tachado são lidos por dentro, como lá.
const MD_LINK = '\\[[^\\[\\]\\n]+\\]\\((?:https?:\\/\\/|\\/)(?:[^)\\s\\[]|\\[(?![^\\[\\]\\n]*\\]\\())+\\)';
const INLINE = new RegExp(
  [
    '(`[^`\\n]+`)',
    `(${MD_LINK})`,
    '((?:https?:\\/\\/|www\\.)[^\\s<]+[^\\s<.,;:!?)\\]\'"])',
    '(\\*\\*[^*\\n]+\\*\\*|\\*[^*\\s][^*\\n]*\\*)',
    '(__[^_\\n]+__|(?<![\\w])_[^_\\s][^_\\n]*_(?![\\w]))',
    '(~~[^~\\n]+~~|~[^~\\s][^~\\n]*~)',
    '((?<![\\w@])@[0-9a-zA-Z._-]+)',
  ].join('|'),
  'g',
);
function rendered(text: string, out = { hrefs: [] as string[], groups: [] as string[] }) {
  for (const m of text.matchAll(INLINE)) {
    const [, code, mdLink, url, bold, italic, strike, mention] = m;
    if (code) continue;
    if (mdLink) out.hrefs.push(/^\[([^\]]+)\]\(([^)]+)\)$/.exec(mdLink)![2]);
    else if (url) out.hrefs.push(url.startsWith('www.') ? `https://${url}` : url);
    else if (bold || italic || strike) {
      const s = (bold || italic || strike)!;
      const two = s.startsWith('**') || s.startsWith('__') || s.startsWith('~~');
      rendered(two ? s.slice(2, -2) : s.slice(1, -1), out);
    } else if (mention) {
      const name = mention.slice(1).replace(/\.+$/, '');
      if (name === 'all' || name === 'here') out.groups.push(name);
    }
  }
  return out;
}
// Destinos clicáveis que não são https de um host conhecido (caminho do chat e //host também contam).
const foreignLinks = (text: string) =>
  rendered(text).hrefs.filter((h) => {
    if (!/^https:\/\//i.test(h)) return true;
    try {
      return !trustedLinkHost(new URL(h).hostname);
    } catch {
      return true;
    }
  });

describe('html.ts: HTML do Teams → markdown do chat', () => {
  it('menções do Teams viram o nome, sem notificar ninguém', () => {
    expect(md('<p>Olá <at id="0">Ana Teste</at>, tudo bem?</p>')).toBe('Olá Ana Teste, tudo bem?');
    expect(md('<p>@all atenção #geral</p>')).toBe(`@${ZW}all atenção #${ZW}geral`);
  });

  it('javascript: e outros esquemas ficam só com o texto', () => {
    expect(md('<a href="javascript:alert(1)">clique</a>')).toBe('clique');
    expect(md('<a href="http://exemplo.com.br/x">sem https</a>')).toBe('sem https');
    expect(md('<a href="https://usuario:senha@explorer.sharepoint.com/x">com senha</a>')).toBe('com senha');
  });

  it('imagens, emoji pelo alt, anexos removidos e entidades decodificadas', () => {
    expect(md('<p>Veja <img src="https://x.example/y.png" alt="x"> e <emoji id="like" alt="👍" title="Curtir"></emoji></p>')).toBe('Veja [imagem] e 👍');
    expect(md('<p>Arquivo<attachment id="abc123"></attachment> anexado</p>')).toBe('Arquivo anexado');
    expect(md('<p>&amp; &lt;b&gt; &quot;x&quot; &#39;y&#39; &#x1F600; &nbsp;fim</p>')).toBe(`& <b> "x" 'y' 😀 fim`);
  });

  it('listas (também aninhadas e indentadas no HTML) e citações', () => {
    expect(md('<ul><li>um</li><li>dois<ul><li>dois.a</li></ul></li></ul>')).toBe('- um\n- dois\n  - dois.a');
    expect(md('<ul>\n  <li>um</li>\n  <li>dois\n    <ol><li>a</li><li>b</li></ol>\n  </li>\n</ul><p>fim</p>')).toBe('- um\n- dois\n  1. a\n  2. b\n\nfim');
    expect(md('<blockquote>citação<br>linha 2</blockquote><p>depois</p>')).toBe('> citação\n> linha 2\n\ndepois');
  });

  it('negrito, itálico, código e bloco de código (com a indentação)', () => {
    expect(md('<p><b>negrito</b> e <i>itálico</i> e <code>x</code></p>')).toBe('**negrito** e _itálico_ e `x`');
    expect(md('<pre>  def x():\n      return 1</pre>')).toBe('```\n  def x():\n      return 1\n```');
  });

  it('<script>, <style> e o conteúdo deles somem', () => {
    expect(md('<p>antes</p><script>alert(1)</script><style>p{color:red}</style><p>depois</p>')).toBe('antes\n\ndepois');
    expect(md('<p>a</p><script>document.write("<b>x</b>")</script>')).toBe('a');
  });

  it('H2: texto visível de um host confiável não esconde um destino estranho', () => {
    const out = md('<a href="https://evil.example">teams.microsoft.com</a>');
    expect(out.replaceAll(ZW, '')).toBe('teams.microsoft.com (https://evil.example)');
    // O endereço estranho fica à mostra, mas sem clique (U+200B entre "https:" e "//").
    expect(out).toContain(`https:${ZW}//evil.example`);
    expect(out).not.toContain('](');
  });

  it('H2: link do SharePoint continua link; de outro host, texto com o endereço sem clique', () => {
    expect(md('<a href="https://explorer.sharepoint.com/sites/ops/doc.docx">Planilha</a>')).toBe('[Planilha](https://explorer.sharepoint.com/sites/ops/doc.docx)');
    expect(md('<a href="https://example.com/x">Site</a>')).toBe(`Site (https:${ZW}//example.com/x)`);
  });

  it('M14: link de reunião embrulhado pelo Safe Links é aceito e normalizado', () => {
    const inner = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_falso%40thread.v2/0?context=%7b%22Tid%22%3a%22x%22%7d';
    const wrapped = `https://nam12.safelinks.protection.outlook.com/?url=${encodeURIComponent(inner)}&data=05%7C02&reserved=0`;
    expect(normalizeTeamsMeetingUrl(wrapped)).toBe(new URL(inner).toString());
    expect(normalizeTeamsMeetingUrl('https://teams.microsoft.com/meet/123456789?p=abc')).toBe('https://teams.microsoft.com/meet/123456789?p=abc');
    expect(normalizeTeamsMeetingUrl('https://teams.microsoft.com/l/chat/0/0?users=ana@explorer.com.br')).toBeNull();
    expect(normalizeTeamsMeetingUrl('https://teams.microsoft.com.evil.example/l/meetup-join/x')).toBeNull();
    // Dentro de uma mensagem do Teams, o link embrulhado vira o link limpo.
    expect(md(`<a href="${wrapped}">Entrar</a>`)).toBe(`[Entrar](${inner})`);
  });

  it('mensagem inteira: assunto em negrito, arquivo do SharePoint e cartão escondido', () => {
    const text = teamsMessageText(
      {
        subject: 'Plantão',
        body: { contentType: 'html', content: '<p>oi</p>' },
        attachments: [
          { contentType: 'reference', name: 'Escala.xlsx', contentUrl: 'https://explorer.sharepoint.com/sites/ops/Escala.xlsx' },
          { contentType: 'application/vnd.microsoft.card.adaptive', content: '{}' },
        ],
      },
      o,
    );
    expect(text).toBe(`**Plantão**\noi\nArquivo no Teams: Escala.xlsx (https://explorer.sharepoint.com/sites/ops/Escala.xlsx)\n${HTML_TEXT.hidden}`);
    expect(teamsMessageText({ body: { contentType: 'html', content: `<p>${'a'.repeat(200)}</p>` } }, { ...o, max: 50 })).toHaveLength(50);
  });

  it('D21: link, menção e link markdown partidos entre tags, comentários, <img> e <emoji> continuam sem clique', () => {
    const cases = [
      '<p>Atualize sua senha em https:<span>//evil.example/login</span></p>',
      '<p>https:<!---->//evil.example/x</p>',
      '<p>www.<span>evil.example/login</span></p>',
      '<p>Novo portal: <img src="https://x.example/a.png">(//evil.example/rh)</p>',
      '<p>[Seu acesso expira, clique aqui]<b></b>(//evil.example/acesso)</p>',
      '<p>[Redefina sua senha]<!-- -->(//evil.example/x)</p>',
      '<p>[Redefina sua senha]<span></span>(/account/profile)</p>',
      '<p>[Redefina]<span></span>(https://evil.example/x)</p>',
      '<p>Clique: <emoji alt="👉"></emoji>[Portal RH]<i></i>(//evil.example/rh)</p>',
      '<p>[Portal<emoji alt="]"></emoji>(//evil.example/rh)</p>',
      '<p><b>[Folha de ponto</b>](//evil.example/ponto)</p>',
      // Texto colado num link de host conhecido não ganha clique por causa dele.
      '<p>https://evil.example/<a href="https://explorer.sharepoint.com/x">planilha</a></p>',
      '<p>www.<a href="https://explorer.sharepoint.com/x">evil.example</a></p>',
      '<p><a href="https://teams.microsoft.com">https://teams.microsoft.com</a>.evil.example/x</p>',
    ];
    for (const html of cases) {
      const out = md(html);
      expect(foreignLinks(out), `${html} → ${JSON.stringify(out)}`).toEqual([]);
      const full = teamsMessageText({ body: { contentType: 'html', content: html } }, o);
      expect(foreignLinks(full), `${html} → ${JSON.stringify(full)}`).toEqual([]);
    }
    // O link do host conhecido continua link, mesmo com texto de fora colado nele.
    expect(rendered(md('<p>https://evil.example/<a href="https://explorer.sharepoint.com/x">planilha</a></p>')).hrefs).toContain('https://explorer.sharepoint.com/x');
    for (const html of ['<p>@<span>all</span> reunião agora</p>', '<p>@<span></span>all atenção</p>', '<p>@<!-- -->here</p>', '<p><b>@</b>all</p>', '<a href="https://explorer.sharepoint.com/x">@all</a>']) {
      const out = md(html);
      expect(rendered(out).groups, `${html} → ${JSON.stringify(out)}`).toEqual([]);
    }
    expect(md('<p>#<b></b>geral</p>')).toBe(`#${ZW}geral`);
  });

  it('D21: assunto, nome de arquivo e corpo não montam link entre si', () => {
    const text = teamsMessageText(
      {
        subject: '[Clique aqui]',
        body: { contentType: 'html', content: '<p>(//evil.example/x)</p>' },
        attachments: [{ contentType: 'reference', name: '[Portal](//evil.example/y)', contentUrl: 'https://explorer.sharepoint.com/sites/ops/a.xlsx' }],
      },
      o,
    );
    expect(foreignLinks(text)).toEqual([]);
    expect(rendered(text).hrefs).toEqual(['https://explorer.sharepoint.com/sites/ops/a.xlsx']);
    const plain = teamsMessageText({ body: { contentType: 'text', content: '[x](//evil.example/z) @all' } }, o);
    expect(foreignLinks(plain)).toEqual([]);
    expect(rendered(plain).groups).toEqual([]);
  });

  it('caracteres de controle do Teams não imitam as marcas internas (bloco de código, link guardado)', () => {
    const out = md('<p>&#2;0&#2; e &#3;0&#3; e \u00030\u0003</p><pre>segredo</pre><a href="https://explorer.sharepoint.com/x">doc</a>');
    expect(out.match(/segredo/g)).toHaveLength(1);
    expect(out.match(/\[doc\]/g)).toHaveLength(1);
    expect(out).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
  });

  it('D21: nada some depois de safeText: controles e marcas que um Safe Links desembrulha (%00, %01, %03) não montam link nem menção', () => {
    const SL = (inner: string) => `https://nam11.safelinks.protection.outlook.com/?url=${inner}&amp;data=05`;
    const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
    const cases = [
      `<p>Atualize sua senha: ${SL('https%3A%01%2F%2Fevil.example%2Flogin')}</p>`,
      `<p>Atualize: ${SL('https%3A%00%2F%2Fevil.example%2Fz')}</p>`,
      `<p>${SL('www%01.evil.example%2Fx')}</p>`,
      `<p>${SL('%5BSeu%20acesso%20expira%2C%20clique%20aqui%5D%01(%2F%2Fevil.example%2Facesso)')}</p>`,
      `<p>${SL('%5BPortal%20RH%5D%039%03(%2Faccount%2Fprofile)')}</p>`,
      `<p>${SL('%5BPortal%20RH%5D%030%03(%2Faccount%2Fprofile)')} <a href="https://explorer.sharepoint.com/x">doc</a></p>`,
      `<p>${SL('%5BPortal%20RH%5D%02%02(%2Faccount%2Fprofile)')}</p><pre>x</pre>`,
      // No rótulo de um link de host conhecido: "]" e "(" desembrulhados não fecham o rótulo antes.
      `<p><a href="https://explorer.sharepoint.com/x">Ver ${SL('%5D%01(%2F%2Fevil.example%2Fy)')}</a></p>`,
      `<p><a href="https://explorer.sharepoint.com/x">Ver ${SL('%5D(%2F%2Fevil.example%2Fy)%20%5B')}</a></p>`,
    ];
    for (const html of cases) {
      const out = md(html);
      expect(foreignLinks(out), `${html} → ${JSON.stringify(out)}`).toEqual([]);
      expect(out, html).not.toMatch(CTRL);
      const full = teamsMessageText({ body: { contentType: 'html', content: html } }, o);
      expect(foreignLinks(full), `${html} → ${JSON.stringify(full)}`).toEqual([]);
    }
    expect(md(`<p>Atualize sua senha: ${SL('https%3A%01%2F%2Fevil.example%2Flogin')}</p>`)).toBe(`Atualize sua senha: https:${ZW}//evil.example/login`);
    expect(md(`<p>${SL('%5BPortal%20RH%5D%039%03(%2Faccount%2Fprofile)')}</p>`)).toBe(`[Portal RH]${ZW}9${ZW}(/account/profile)`);
    for (const html of [`<p>${SL('%40%01all')} reunião agora</p>`, `<p>${SL('%40%00here')}</p>`, `<p>${SL('%40%7F%01all')}</p>`]) {
      const out = md(html);
      expect(rendered(out).groups, `${html} → ${JSON.stringify(out)}`).toEqual([]);
    }
    // Assunto e texto puro passam pela mesma passada.
    const raw = (inner: string) => SL(inner).replace('&amp;', '&');
    const subject = teamsMessageText({ subject: raw('https%3A%01%2F%2Fevil.example%2Fs'), body: { contentType: 'html', content: '<p>oi</p>' } }, o);
    const plain = teamsMessageText({ body: { contentType: 'text', content: `${raw('https%3A%01%2F%2Fevil.example%2Fp')} ${raw('%40%01all')}` } }, o);
    for (const t of [subject, plain]) {
      expect(foreignLinks(t), t).toEqual([]);
      expect(rendered(t).groups, t).toEqual([]);
      expect(t).not.toMatch(CTRL);
    }
    // Uma marca imitada (%03 0 %03) não toma o lugar do link de verdade, que fica onde estava.
    expect(md(`<p>${SL('%030%03')} texto <a href="https://explorer.sharepoint.com/x">Abrir</a></p>`)).toBe(`${ZW}0${ZW} texto [Abrir](https://explorer.sharepoint.com/x)`);
    // Destino de um link de host conhecido com controle: vai codificado, nada some do endereço.
    expect(md(`<a href="${SL('https%3A%2F%2Fexplorer.sharepoint.com%2Fa%01b')}">doc</a>`)).toBe('[doc](https://explorer.sharepoint.com/a%01b)');
  });

  it('nomes de fora numa linha: o que o Safe Links desembrulha (U+0000, quebra, @all) não chega ao banco nem menciona', () => {
    const SL = (inner: string) => `https://x.safelinks.protection.outlook.com/?url=${inner}`;
    expect(safeName(`Convidado ${SL('%00%40all')}`, safeExternalText)).toBe(`Convidado @${ZW}all`);
    expect(safeName(`Convidado ${SL('%40%01all')}`, safeExternalText)).toBe('Convidado @ all');
    expect(safeName(`Ana ${SL('%0ASouza%0D%0A%09')}`, safeExternalText)).toBe('Ana Souza');
    expect(safeName('Ana\u0000\u0007 Souza\n', safeExternalText)).toBe('Ana Souza');
    expect(safeName(`${'é'.repeat(79)}😀😀`, safeExternalText)).toBe(`${'é'.repeat(79)}😀`);
    expect(safeName(null, safeExternalText)).toBe('');
    for (const n of [`x ${SL('%00')}`, `x ${SL('%01%02%03%7F')}`]) expect(safeName(n, safeExternalText)).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it('corpo só de cartões: lido pela árvore, e "<" sem ">" às dezenas de milhares termina rápido', () => {
    expect(htmlIsBlank('<attachment id="c1"></attachment>')).toBe(true);
    expect(htmlIsBlank('<p>&nbsp;</p>\n<attachment id="c1"></attachment> <img src="https://x.example/a.png">')).toBe(true);
    expect(htmlIsBlank('')).toBe(true);
    expect(htmlIsBlank('<p>oi</p><attachment id="c1"></attachment>')).toBe(false);
    expect(htmlIsBlank('<attachment id="c1"></attachment>&lt;')).toBe(false);
    expect(htmlIsBlank('<attachment id="c1">texto</attachment>')).toBe(false);
    const cases: Record<string, string> = {
      '100 mil "<"': `${'<'.repeat(100_000)}<attachment id="c1"></attachment>`,
      '28 mil "<"': `${'<'.repeat(28_000)}<attachment id="c1"></attachment>`,
      '"<attachment" 9000 vezes': '<attachment'.repeat(9000),
      '"<attachment>" e espaços sem fechar': `${'<attachment id="c1">'.repeat(2000)}${' '.repeat(50_000)}`,
      '"<a" + 100 KB de letras': `<a${'b'.repeat(99_990)}`,
    };
    for (const [name, html] of Object.entries(cases)) {
      const t0 = performance.now();
      htmlIsBlank(html);
      const ms = performance.now() - t0;
      expect(ms, `${name}: ${Math.round(ms)} ms`).toBeLessThan(200);
    }
  });

  it('entradas montadas para travar: muitos níveis e buscas sem fim terminam rápido, sem estourar a pilha', () => {
    const cases: Record<string, string> = {
      '3000 <b> aninhados': `<p>${'<b>'.repeat(3000)}x</p>`,
      '2000 <span> aninhados': `<p>${'<span>'.repeat(2000)}x</p>`,
      '33 mil <b>': `${'<b>'.repeat(33_000)}x`,
      '20 mil <i> + 9 mil </x>': `${'<i>'.repeat(20_000)}x${'</x>'.repeat(9_000)}`,
      '5000 <li> aninhados': `${'<ul><li>'.repeat(5000)}x`,
      '5000 <blockquote> e 10 mil <br>': `${'<blockquote>'.repeat(5000)}${'a<br>'.repeat(10_000)}`,
      '"<a" + 100 KB de letras': `<a${'b'.repeat(99_990)}`,
      '"<" + 2000 letras, 49 vezes': `<${'b'.repeat(2000)}`.repeat(49),
      '"<a " repetido': '<a '.repeat(33_000),
      '"<!" repetido': '<!'.repeat(50_000),
      '"<a" + 2000 espaços, 49 vezes': `<a${' '.repeat(2000)}`.repeat(49),
      'rótulo de link enorme': `<a href="https://explorer.sharepoint.com/x">${'a.'.repeat(45_000)}!</a>`,
    };
    for (const [name, content] of Object.entries(cases)) {
      const t0 = performance.now();
      let out = '';
      expect(() => (out = teamsMessageText({ body: { contentType: 'html', content } }, o)), name).not.toThrow();
      const ms = performance.now() - t0;
      expect(ms, `${name}: ${Math.round(ms)} ms`).toBeLessThan(300);
      if (name.includes('aninhados') || name.startsWith('33')) expect(out, name).toContain('x');
    }
  });
});

describe('cards.ts: cartão para o Teams', () => {
  const at = new Date(2026, 9, 22, 9, 5).toISOString();
  const base: CardInput = {
    ruleId: 'R1',
    messageId: 'M1',
    siteName: 'Wescc Chat',
    room: { name: 'operacao', t: 'c' },
    author: { name: 'Ana Lima', username: 'ana.lima' },
    text: 'Fila *cheia* no turno da noite',
    at,
    files: [],
    ack: false,
    link: 'https://chat.explorer.example/channel/R?msg=M1',
  };
  const content = (card: any) => card.attachments[0].content;

  it('forma do Adaptive Card, marcador wescc: e fallbackText legível', () => {
    const card: any = buildCard(base);
    expect(card.type).toBe('message');
    expect(card.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(content(card)).toMatchObject({ type: 'AdaptiveCard', version: '1.4', fallbackText: 'Mensagem de Ana Lima em #operacao no Wescc Chat' });
    const body = content(card).body;
    expect(body[0]).toMatchObject({ type: 'TextBlock', id: 'wescc:R1:M1', text: '#operacao · Wescc Chat · 09:05', size: 'Small', isSubtle: true });
    expect(body[1]).toMatchObject({ text: 'Ana Lima', weight: 'Bolder' });
    expect(body[2].text).toBe('Fila **cheia** no turno da noite');
    expect(content(card).actions).toEqual([{ type: 'Action.OpenUrl', title: 'Abrir no Wescc Chat', url: base.link }]);
  });

  it('grupo privado, hora original, linha do tópico, arquivos, Ciente e sem link', () => {
    const files = Array.from({ length: 22 }, (_, i) => ({ name: `f${i + 1}.pdf` }));
    const card: any = buildCard({ ...base, room: { name: 'supervisao', t: 'p' }, rootExcerpt: 'Troca de turno', files, ack: true, link: null });
    const texts = content(card).body.map((b: any) => b.text);
    expect(texts[0]).toBe('Grupo privado supervisao · Wescc Chat · 09:05');
    expect(texts).toContain('Resposta no tópico “Troca de turno”');
    expect(texts).toContain(`Arquivos: ${files.slice(0, 20).map((f) => f.name).join(', ')} e mais 2`);
    expect(texts).toContain('Este aviso pede confirmação de leitura no Wescc Chat.');
    expect(content(card).actions).toEqual([]);
    expect(hhmm(at)).toBe('09:05');
  });

  it('linha do Jira e markdown do chat traduzido para o cartão', () => {
    const card: any = buildCard({ ...base, jira: { kind: 'share', site: 'x', issues: [{ key: 'OPS-1', summary: 'Fila parada', status: { name: 'Em andamento' } } as any] } as any });
    expect(content(card).body.map((b: any) => b.text)).toContain('OPS-1: Fila parada · Em andamento');
    expect(chatMarkdownToCard('__it__ ~~riscado~~ `*x*` [sala](/channel/x) [site](https://a.example)\n* item')).toBe('_it_ riscado *x* sala [site](https://a.example)\n- item');
  });

  it('texto grande é cortado para caber em 28 000 bytes e termina com o aviso', () => {
    const card: any = buildCard({ ...base, text: 'é'.repeat(40_000) });
    expect(cardBytes(card)).toBeLessThanOrEqual(CARD_MAX_BYTES);
    expect(cardBytes(card)).toBeGreaterThan(CARD_MAX_BYTES - 200);
    expect(content(card).body[2].text.endsWith('… (continua no Wescc Chat)')).toBe(true);
  });

  it('resumo: título com o total, até 5 linhas e marcador do resumo', () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ author: `Pessoa ${i + 1}`, text: `**Mensagem** ${i + 1}` }));
    const card: any = buildDigestCard({ ruleId: 'R1', siteName: 'Wescc Chat', room: { name: 'operacao', t: 'c' }, items, total: 12, link: 'https://chat.explorer.example/channel/R' });
    const body = content(card).body;
    expect(body[0]).toMatchObject({ id: 'wescc:R1:resumo', text: '#operacao · Wescc Chat' });
    expect(body[1]).toMatchObject({ text: '12 mensagens novas em #operacao no Wescc Chat', weight: 'Bolder' });
    expect(body.slice(2).map((b: any) => b.text)).toEqual(['Pessoa 1: Mensagem 1', 'Pessoa 2: Mensagem 2', 'Pessoa 3: Mensagem 3', 'Pessoa 4: Mensagem 4', 'Pessoa 5: Mensagem 5']);
    expect(content(card).fallbackText).toBe('12 mensagens novas em #operacao no Wescc Chat');
    expect(digestTitle(1, { name: 'operacao', t: 'c' }, 'Wescc Chat')).toBe('1 mensagem nova em #operacao no Wescc Chat');
  });

  it('resumo de uma regra com várias salas: cada linha diz de que sala veio e o título não atribui tudo à primeira', () => {
    const ops = { name: 'operacao', t: 'c' as const };
    const sup = { name: 'suporte', t: 'p' as const };
    const items = [
      { author: 'Ana', text: 'fila cheia', room: ops },
      { author: 'Bia', text: '**sistema** lento', room: sup },
      { author: 'Caio', text: 'ok', room: ops },
    ];
    const card: any = buildDigestCard({ ruleId: 'R1', siteName: 'Wescc Chat', room: ops, rooms: [ops, sup], items, total: 7, link: null });
    const body = content(card).body;
    expect(body[0]).toMatchObject({ id: 'wescc:R1:resumo', text: '#operacao, Grupo privado suporte · Wescc Chat' });
    expect(body[1]).toMatchObject({ text: '7 mensagens novas em 2 salas no Wescc Chat', weight: 'Bolder' });
    expect(body.slice(2).map((b: any) => b.text)).toEqual(['#operacao · Ana: fila cheia', 'Grupo privado suporte · Bia: sistema lento', '#operacao · Caio: ok']);
    expect(content(card).fallbackText).toBe('7 mensagens novas em 2 salas no Wescc Chat');
    // Uma sala só: o texto do §5.3, sem a sala em cada linha.
    const one: any = buildDigestCard({ ruleId: 'R1', siteName: 'Wescc Chat', room: ops, rooms: [ops], items: [items[0]], total: 1, link: null });
    expect(content(one).body.map((b: any) => b.text)).toEqual(['#operacao · Wescc Chat', '1 mensagem nova em #operacao no Wescc Chat', 'Ana: fila cheia']);
  });
});

describe('reuniões e presença (funções de @shared/integrations)', () => {
  it('teamsScheduleLink: espaço vira %20 (nunca +), deslocamento explícito e convidados por UPN', () => {
    const start = new Date('2026-10-22T17:30:00Z');
    const url = teamsScheduleLink({
      subject: 'Reunião em #operacao',
      start,
      end: new Date(start.getTime() + 30 * 60_000),
      offsetMinutes: -180,
      content: 'Marcada pelo Wescc Chat em #operacao',
      attendeesUpn: ['ana@explorer.example', 'bruno@explorer.example'],
    });
    expect(url.startsWith('https://teams.microsoft.com/l/meeting/new?')).toBe(true);
    expect(url).not.toContain('+');
    expect(url).toContain('subject=Reuni%C3%A3o%20em%20%23operacao');
    expect(url).toContain(`startTime=${encodeURIComponent('2026-10-22T14:30:00-03:00')}`);
    expect(url).toContain(`endTime=${encodeURIComponent('2026-10-22T15:00:00-03:00')}`);
    expect(url).toContain('attendees=ana%40explorer.example,bruno%40explorer.example');
  });

  it('teamsPresenceLabel em pt-BR', () => {
    expect(teamsPresenceLabel('Busy', 'InAMeeting')).toBe('Em reunião');
    expect(teamsPresenceLabel('Busy', 'InACall')).toBe('Em chamada');
    expect(teamsPresenceLabel('DoNotDisturb', 'Presenting')).toBe('Apresentando');
    expect(teamsPresenceLabel('AvailableIdle', 'Inactive')).toBe('Disponível');
    expect(teamsPresenceLabel('Away', 'Away')).toBe('Ausente');
    expect(teamsPresenceLabel('PresenceUnknown', 'PresenceUnknown')).toBe('Desconhecido');
  });

  it('recurso de presença com até 650 ids, aspas dobradas e lido de volta', () => {
    const ids = ['00000000-0000-4000-8000-00000000a001', "o'brien"];
    const res = presenceResource(ids);
    expect(res).toBe("/communications/presences?$filter=id in ('00000000-0000-4000-8000-00000000a001','o''brien')");
    expect(idsOfResource(res)).toEqual(ids);
  });
});

describe('outgoing.ts: endereço do fluxo do Workflows', () => {
  const ok = 'https://prod-12.westus.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/abc/triggers/manual/paths/invoke?api-version=1&sig=falso';

  it('aceita o host do Workflows e recusa os endereços aposentados com o texto certo', () => {
    expect(workflowsUrlProblem(ok, [])).toBeNull();
    expect(workflowsUrlProblem('https://prod-01.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=falso', [])).toBe(OUT_TEXT.logicAzure);
    expect(workflowsUrlProblem('https://explorer.webhook.office.com/webhookb2/abc/IncomingWebhook/def', [])).toBe(OUT_TEXT.connector);
    expect(workflowsUrlProblem('https://outlook.office.com/webhook/abc', [])).toBe(OUT_TEXT.connector);
  });

  it('recusa http, outra porta, usuário na URL e outros hosts', () => {
    for (const bad of [
      ok.replace('https:', 'http:'),
      ok.replace(':443', ':8443'),
      ok.replace('https://', 'https://u:p@'),
      'https://environment.api.powerplatform.com/x',
      'https://exemplo.com.br/workflows/x',
      'não é endereço',
    ]) {
      expect(workflowsUrlProblem(bad, [])).toBe(OUT_TEXT.workflowsUrl);
    }
    expect(workflowsUrlProblem('http://127.0.0.1:4567/workflows/x', ['127.0.0.1:4567'])).toBeNull();
  });

  it("M15: o público do token do Power Automate é exatamente 'https://service.flow.microsoft.com/'", () => {
    expect(FLOW_AUDIENCE).toBe('https://service.flow.microsoft.com/');
    expect(FLOW_SCOPE).toBe('https://service.flow.microsoft.com//.default');
  });
});

describe('budget.ts: limite de posts por dono do fluxo', () => {
  const now = new Date(2026, 9, 22, 10, 0).getTime();

  it('começa livre e para no limite, com a espera até o post mais antigo sair da janela', () => {
    let st: any = null;
    for (let i = 0; i < 20; i++) {
      const r = takeFrom(st, 20, now + i * 1000);
      expect(r.ok).toBe(true);
      st = r.state;
    }
    const r = takeFrom(st, 20, now + 20_000);
    expect(r.ok).toBe(false);
    expect(r.waitMs).toBe(BUDGET_WINDOW_MS - 20_000);
    expect(r.state.dayCount).toBe(20);
    expect(takeFrom(st, 20, now + BUDGET_WINDOW_MS).ok).toBe(true);
  });

  it('D12: nunca mais que a capacidade em qualquer janela de 5 minutos, mesmo com tentativas sem parar', () => {
    let st: any = null;
    const accepted: number[] = [];
    // 20 tentativas no primeiro segundo e depois uma por segundo durante 15 minutos (duas regras do mesmo dono com fila cheia).
    for (let s = 0; s < 900; s++) {
      for (let i = 0; i < (s === 0 ? 20 : 1); i++) {
        const r = takeFrom(st, 20, now + s * 1000);
        st = r.state;
        if (r.ok) accepted.push(now + s * 1000);
      }
    }
    for (const t of accepted) expect(accepted.filter((x) => x >= t && x - t < BUDGET_WINDOW_MS).length).toBeLessThanOrEqual(20);
    expect(accepted).toHaveLength(60);
  });

  it('capacidade menor (5) com posts de antes na janela espera os que sobram saírem; o dia conta pela hora do servidor', () => {
    let st: any = null;
    for (let i = 0; i < 12; i++) st = takeFrom(st, 20, now + i * 1000).state;
    const r = takeFrom(st, 5, now + 12_000);
    expect(r.ok).toBe(false);
    // Saem 8 dos 12 para sobrar vaga: o 8.º mais antigo foi em now + 7 s.
    expect(r.waitMs).toBe(7000 + BUDGET_WINDOW_MS - 12_000);
    expect(takeFrom(st, 5, now + 7000 + BUDGET_WINDOW_MS).ok).toBe(true);
    const busy = { times: [now], day: localDay(new Date(now)), dayCount: 300 };
    expect(takeFrom(busy, 10, now + 1000).state.dayCount).toBe(301);
    const tomorrow = new Date(2026, 9, 23, 0, 1).getTime();
    expect(takeFrom(busy, 10, tomorrow).state.dayCount).toBe(1);
    expect(budgetKey('  Fluxos@Explorer.Example ')).toBe('msteams.budget:fluxos@explorer.example');
  });
});

describe('graph.ts e notifications.ts: erros e recursos', () => {
  it('erros do Entra viram os textos do §5.2', () => {
    expect(tokenError(401, { error: 'invalid_client', error_codes: [7000215] })).toMatchObject({ statusCode: 400, errorType: 'error-msteams-secret', message: GRAPH_TEXT.secret });
    expect(tokenError(400, { error: 'unauthorized_client', error_description: 'AADSTS700016: app not found' })).toMatchObject({ errorType: 'error-msteams-app', message: GRAPH_TEXT.app });
    expect(tokenError(400, { error: 'invalid_grant', error_codes: [65001] })).toMatchObject({ errorType: 'error-msteams-consent' });
    expect(tokenError(400, { error: 'invalid_grant', error_codes: [53003] })).toMatchObject({ errorType: 'error-msteams-service', message: GRAPH_TEXT.conditional, graphCode: 'invalid_grant' });
    expect(tokenError(400, { error: 'invalid_grant', error_codes: [50173] })).toMatchObject({ errorType: 'error-msteams-service', message: GRAPH_TEXT.reauth });
    expect(tokenError(503, null)).toMatchObject({ statusCode: 502, errorType: 'error-msteams-unavailable' });
  });

  it('claims do token, Retry-After e aspas do $filter', () => {
    const jwt = ['e30', Buffer.from(JSON.stringify({ roles: ['User.Read.All'], oid: 'oid-1', scp: 'User.Read' })).toString('base64url'), 'x'].join('.');
    expect(tokenClaims(jwt)).toEqual({ roles: ['User.Read.All'], oid: 'oid-1', scp: 'User.Read' });
    expect(tokenClaims('lixo')).toEqual({});
    expect(retryAfterMs('7')).toBe(7000);
    expect(retryAfterMs(undefined)).toBeUndefined();
    expect(odataQuote("d'avila@explorer.example")).toBe("'d''avila@explorer.example'");
  });

  it('recurso de uma notificação de mensagem ou resposta', () => {
    expect(parseMessageResource("teams('t-1')/channels('19:abc@thread.tacv2')/messages('1700')")).toEqual({ teamId: 't-1', channelId: '19:abc@thread.tacv2', messageId: '1700', replyId: null });
    expect(parseMessageResource("teams('t-1')/channels('19:abc@thread.tacv2')/messages('1700')/replies('1701')")).toMatchObject({ messageId: '1700', replyId: '1701' });
    expect(parseMessageResource('/teams/t-1/channels/19%3Aabc%40thread.tacv2/messages/1700')).toMatchObject({ channelId: '19:abc@thread.tacv2' });
    expect(parseMessageResource("users('x')/messages('1')")).toBeNull();
  });
});
