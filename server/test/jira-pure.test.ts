import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { JiraFieldMeta } from '@shared/integrations';
import { adfDoc, adfParagraphs, adfQuote, adfRule, adfToText, textToAdf, wikiToText } from '../src/integrations/jira/adf';
import { fallbackAttachment, toSnapshot, typeKind } from '../src/integrations/jira/cards';
import { classifyItems, commentEvent, commentRestricted, fromHistories, fromSearchIssue, fromWebhook, otherJiraSite, primaryKind, type NormalizedJiraEvent } from '../src/integrations/jira/events';
import { fieldKind, mapFields, mapIssueTypes, toJiraFieldValue } from '../src/integrations/jira/fields';
import { extractIssueRefs, isIssueKey } from '../src/integrations/jira/keys';
import { digestGenericText, digestLine, digestStatusText, eventText, fieldsText, joinList, ruleAnnounce, ruleRelease, shortEventText } from '../src/integrations/jira/texts';

const ORIGIN = 'https://explorer-teste.atlassian.net';
const HOST = 'explorer-teste.atlassian.net';
const fixture = (name: string) => JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures/jira', `${name}.json`), 'utf8'));
const ZW = '​';
const LINK = `[OPS-1](${ORIGIN}/browse/OPS-1)`;
const SUMMARY = 'Fila de atendimento parada no turno da noite';

const issueOf = (name: string) => fixture(name).issue;
const snapOf = (issue = issueOf('webhook-issue-created')) => toSnapshot(issue, ORIGIN);
const one = (name: string): NormalizedJiraEvent => {
  const evs = fromWebhook(fixture(name), ORIGIN);
  expect(evs).toHaveLength(1);
  return evs[0];
};
const noActor = (ev: NormalizedJiraEvent): NormalizedJiraEvent => ({ ...ev, actor: null });

describe('chaves de issue (keys.ts)', () => {
  const o = { siteHost: HOST, projects: ['OPS', 'SUP'], max: 3 };

  it('acha chaves soltas dos projetos listados, em ordem e sem repetir', () => {
    expect(extractIssueRefs('Veja OPS-12 e SUP-3, depois OPS-12 de novo.', o)).toEqual(['OPS-12', 'SUP-3']);
  });

  it('ignora código, outros sites, e-mails, minúsculas e projetos desconhecidos', () => {
    const text = [
      '```\nOPS-1 dentro do bloco\n```',
      'e `OPS-2` inline',
      'https://outro.atlassian.net/browse/OPS-3',
      'https://outro.atlassian.net/jira/software/projects/OPS/boards/1?selectedIssue=OPS-4',
      'escreva para OPS-5@empresa.com ou ana.OPS-6@empresa.com',
      'ops-7 em minúsculas',
      'COVID-19 e ABC-1',
      'versão/OPS-8 e x.OPS-9 e OPS-10-a',
    ].join('\n');
    expect(extractIssueRefs(text, o)).toEqual([]);
  });

  it('aceita links do site configurado (/browse e selectedIssue)', () => {
    const text = `Olha ${ORIGIN}/browse/OPS-21 e ${ORIGIN}/jira/software/projects/OPS/boards/1?selectedIssue=SUP-22.`;
    expect(extractIssueRefs(text, o)).toEqual(['OPS-21', 'SUP-22']);
  });

  it('para no máximo pedido', () => {
    expect(extractIssueRefs('OPS-1 OPS-2 OPS-3 OPS-4 OPS-5', o)).toEqual(['OPS-1', 'OPS-2', 'OPS-3']);
    expect(extractIssueRefs('OPS-1 OPS-2', { ...o, max: 1 })).toEqual(['OPS-1']);
    expect(extractIssueRefs('OPS-1', { ...o, projects: [] })).toEqual([]);
  });

  it('sem site configurado só valem as chaves soltas', () => {
    expect(extractIssueRefs(`${ORIGIN}/browse/OPS-1 e OPS-2`, { ...o, siteHost: null })).toEqual(['OPS-2']);
  });

  it('isIssueKey confere a forma exata', () => {
    expect(isIssueKey('OPS-1')).toBe(true);
    expect(isIssueKey('ops-1')).toBe(false);
    expect(isIssueKey('OPS-0')).toBe(false);
    expect(isIssueKey('OPS-1 ')).toBe(false);
  });
});

describe('ADF e wiki (adf.ts)', () => {
  it('ida e volta de texto com parágrafos, quebras e links', () => {
    const text = 'Primeira linha\nsegunda linha com https://explorer-teste.atlassian.net/browse/OPS-1\n\nOutro parágrafo.';
    const doc = textToAdf(text);
    expect(doc.type).toBe('doc');
    expect(doc.version).toBe(1);
    expect(doc.content).toHaveLength(2);
    const link = doc.content![0].content!.find((n) => n.marks?.length);
    expect(link?.marks?.[0]).toEqual({ type: 'link', attrs: { href: 'https://explorer-teste.atlassian.net/browse/OPS-1' } });
    expect(doc.content![0].content!.some((n) => n.type === 'hardBreak')).toBe(true);
    expect(adfToText(doc)).toBe(text);
  });

  it('texto vazio vira um documento válido', () => {
    expect(textToAdf('')).toEqual({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [] }] });
  });

  it('régua e citação para a descrição criada pelo chat', () => {
    const doc = adfDoc([...adfParagraphs('Texto da pessoa'), adfRule(), ...adfParagraphs('Mensagem original:'), adfQuote('linha 1\nlinha 2')]);
    expect(adfToText(doc)).toBe('Texto da pessoa\n\n---\n\nMensagem original:\n\n> linha 1\n> linha 2');
  });

  it('ADF do Jira com menção, emoji, lista, código e cartão vira texto simples', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'x', text: '@Ana Teste' } }, { type: 'text', text: ' veja ' }, { type: 'emoji', attrs: { shortName: ':smile:', text: '😄' } }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'um' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'dois' }] }] }] },
        { type: 'codeBlock', content: [{ type: 'text', text: 'npm test' }] },
        { type: 'paragraph', content: [{ type: 'inlineCard', attrs: { url: 'https://explorer-teste.atlassian.net/browse/OPS-2' } }] },
        { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'img' } }] },
      ],
    };
    expect(adfToText(doc)).toBe('@Ana Teste veja 😄\n\n- um\n- dois\n\nnpm test\n\nhttps://explorer-teste.atlassian.net/browse/OPS-2');
  });

  it('wikiToText tira as marcações do Jira', () => {
    expect(wikiToText('h2. Título\n*negrito* e _itálico_ e {{mono}}\n[o painel|https://x.atlassian.net/browse/OPS-1] e [~accountid:123]\n{code:java}a = 1;{code}\n* item\n!foto.png!')).toBe(
      'Título\nnegrito e itálico e mono\no painel (https://x.atlassian.net/browse/OPS-1) e @pessoa\na = 1;\n- item',
    );
    expect(wikiToText('{quote}citado{quote}')).toBe('> citado');
    expect(wikiToText('')).toBe('');
  });
});

describe('normalização (events.ts)', () => {
  it('issue criada', () => {
    const ev = one('webhook-issue-created');
    expect(ev).toMatchObject({ key: 'n:10001', kinds: ['created'], issueId: '10001', issueKey: 'OPS-1', issue: null, restricted: false });
    expect(ev.actor).toEqual({ accountId: '712020:00000000-0000-4000-8000-0000000000a1', displayName: 'Ana Teste' });
    expect(ev.at).toBe('2026-10-22T12:00:00.000Z');
  });

  it('status e resolução no mesmo histórico', () => {
    const ev = one('webhook-issue-updated-status-resolution');
    expect(ev.key).toBe('h:20001');
    expect(ev.kinds.sort()).toEqual(['resolved', 'status']);
    expect(ev.changes).toEqual([
      { field: 'resolution', label: 'Resolução', from: null, to: 'Feito' },
      { field: 'status', label: 'Status', from: 'Em andamento', to: 'Concluído' },
    ]);
    expect(primaryKind(ev, ['status', 'resolved'])).toBe('resolved');
    expect(primaryKind(ev, ['status'])).toBe('status');
    expect(primaryKind(ev, ['created', 'commented'])).toBeNull();
  });

  it('responsável, prioridade e outras alterações (campos ignorados ficam de fora)', () => {
    const a = one('webhook-issue-assignee');
    expect(a).toMatchObject({ key: 'h:20002', kinds: ['assigned'], assignee: { accountId: '712020:00000000-0000-4000-8000-0000000000b2', displayName: 'Bruno Teste' } });
    const p = one('webhook-issue-priority');
    expect(p).toMatchObject({ key: 'h:20003', kinds: ['priority'] });
    expect(p.changes[0]).toMatchObject({ label: 'Prioridade', from: 'Média', to: 'Alta' });
    const s = one('webhook-issue-summary');
    expect(s.key).toBe('h:20004');
    expect(s.kinds).toEqual(['updated']);
    expect(s.changes.map((c) => c.label)).toEqual(['Resumo', 'Descrição']);
  });

  it('de/para de um campo longo (Descrição de 20 KB) fica num trecho de até 300 caracteres', () => {
    const big = 'Linha da descrição. '.repeat(1000);
    const r = classifyItems([{ field: 'description', fieldtype: 'jira', fromString: big, toString: `${big}fim` }]);
    expect(r.kinds).toEqual(['updated']);
    expect([...r.changes[0].from!].length).toBeLessThanOrEqual(300);
    expect([...r.changes[0].to!].length).toBeLessThanOrEqual(300);
    expect(r.changes[0].to!.endsWith('…')).toBe(true);
    expect(classifyItems([{ field: 'status', fromString: 'Aberta', toString: 'Em andamento' }]).changes[0]).toMatchObject({ from: 'Aberta', to: 'Em andamento' });
  });

  it('só campos ignorados não geram evento', () => {
    const body = fixture('webhook-issue-summary');
    body.changelog.items = body.changelog.items.filter((i: any) => ['Rank', 'timespent'].includes(i.field));
    expect(fromWebhook(body, ORIGIN)).toEqual([]);
    expect(fromWebhook({ webhookEvent: 'jira:issue_updated', issue: body.issue }, ORIGIN)).toEqual([]);
    expect(fromWebhook({ webhookEvent: 'comment_updated', issue: body.issue, comment: { id: '1' } }, ORIGIN)).toEqual([]);
    expect(fromWebhook({ webhookEvent: 'comment_deleted', issue: body.issue, comment: { id: '1' } }, ORIGIN)).toEqual([]);
    expect(fromWebhook({ webhookEvent: 'jira:issue_created' }, ORIGIN)).toEqual([]);
  });

  it('comentário em wiki vira trecho seguro (sem menção a @all)', () => {
    const ev = one('webhook-issue-comment');
    expect(ev).toMatchObject({ key: 'c:30001', kinds: ['commented'] });
    expect(ev.actor?.displayName).toBe('Bruno Teste');
    expect(ev.comment).toMatchObject({ id: '30001', restricted: false, url: `${ORIGIN}/browse/OPS-1?focusedCommentId=30001` });
    expect(ev.comment!.text).toContain('Reiniciei o serviço da fila. Veja o painel (https://explorer-teste.atlassian.net/browse/OPS-2)');
    expect(ev.comment!.text).toContain(`@${ZW}all`);
    expect(ev.comment!.text).not.toMatch(/(^|\s)@all/);
  });

  it('comentários restritos e internos do Service Management', () => {
    expect(one('webhook-issue-comment-restricted').comment!.restricted).toBe(true);
    expect(one('webhook-issue-comment-jsm-internal').comment!.restricted).toBe(true);
  });

  it('issue excluída', () => {
    expect(one('webhook-issue-deleted')).toMatchObject({ key: 'd:10001', kinds: ['deleted'], issue: null });
  });

  it('nível de segurança marca o evento como restrito', () => {
    const evs = fromSearchIssue(fixture('issue-security-level'), new Date('2026-10-22T11:00:00Z'), ORIGIN);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ key: 'n:10090', kinds: ['created'], restricted: true });
  });

  it('página de busca com changelog: só o que é da janela, em ordem, sem Rank', () => {
    const page = fixture('search-changelog-page');
    const since = new Date('2026-10-22T12:00:00Z');
    const a = fromSearchIssue(page.issues[0], since, ORIGIN);
    expect(a.map((e) => [e.key, e.kinds])).toEqual([
      ['h:21001', ['status']],
      ['h:21003', ['updated']],
    ]);
    expect(a[0].issue.fields.summary).toBe('Painel de filas sem atualizar');
    expect(a[0].issue.fields.description).toBeUndefined();
    expect(a[1].changes[0]).toMatchObject({ label: 'Rótulos', to: 'urgente' });
    const b = fromSearchIssue(page.issues[1], since, ORIGIN);
    expect(b.map((e) => e.key)).toEqual(['h:21010']);
  });

  it('changelog longo: históricos do fim da lista', () => {
    const { issue } = fixture('changelog-long');
    const now = Date.now();
    const histories = Array.from({ length: 100 }, (_, i) => ({
      id: String(40150 + i),
      created: new Date(now - (100 - i) * 3600_000).toISOString(),
      author: { accountId: 'a', displayName: 'Ana Teste' },
      items: [{ field: 'labels', fromString: '', toString: `l${i}` }],
    }));
    histories[99] = { ...histories[99], created: new Date(now - 30_000).toISOString(), items: [{ field: 'status', fromString: 'Em andamento', toString: 'Concluído' } as any] };
    const evs = fromHistories(issue, histories, new Date(now - 120_000));
    expect(evs.map((e) => [e.key, e.kinds])).toEqual([['h:40249', ['status']]]);
  });

  it('comentário lido pela API (ADF) com as marcas do Service Management', () => {
    const issue = fixture('webhook-issue-comment-jsm-internal').issue;
    const c = { id: '9', author: { displayName: 'Bruno' }, created: '2026-10-22T12:00:00Z', body: textToAdf('Olá #geral'), jsdPublic: true };
    const ev = commentEvent(issue, c, ORIGIN, true);
    expect(ev).toMatchObject({ key: 'c:9', kinds: ['commented'], issueKey: 'SUP-7' });
    expect(ev.comment).toMatchObject({ restricted: false, text: `Olá #${ZW}geral` });
  });

  it('commentRestricted: visibilidade, jsdPublic, propriedade e Service Management sem marca', () => {
    expect(commentRestricted({ visibility: { type: 'group', value: 'jira-admins' } }, false)).toBe(true);
    expect(commentRestricted({ jsdPublic: false }, false)).toBe(true);
    expect(commentRestricted({ properties: [{ key: 'sd.public.comment', value: { internal: true } }] }, false)).toBe(true);
    expect(commentRestricted({}, true)).toBe(true);
    expect(commentRestricted({ jsdPublic: true }, true)).toBe(false);
    expect(commentRestricted({ properties: [{ key: 'sd.public.comment', value: { internal: false } }] }, true)).toBe(false);
    expect(commentRestricted({}, false)).toBe(false);
    expect(commentRestricted(null, false)).toBe(true);
  });

  it('otherJiraSite: entrega de outro Jira Cloud (o webhook do site antigo) é reconhecida pelo self da issue', () => {
    const site = 'https://explorer.atlassian.net';
    expect(otherJiraSite('https://explorer-teste.atlassian.net/rest/api/2/issue/10002', site)).toBe('https://explorer-teste.atlassian.net');
    expect(otherJiraSite('https://antigo.jira.com/rest/api/2/issue/10002', site)).toBe('https://antigo.jira.com');
    expect(otherJiraSite('https://explorer.atlassian.net/rest/api/2/issue/10002', site)).toBeNull();
    expect(otherJiraSite('https://EXPLORER.atlassian.net/rest/api/2/issue/10002', site)).toBeNull();
    // Sem self, com self estranho ou fora do Jira Cloud (gateway, endereço liberado no ambiente): não dá para afirmar.
    expect(otherJiraSite(undefined, site)).toBeNull();
    expect(otherJiraSite('não é endereço', site)).toBeNull();
    expect(otherJiraSite('https://api.atlassian.com/ex/jira/abc/rest/api/2/issue/1', site)).toBeNull();
    expect(otherJiraSite('http://antigo.atlassian.net/rest/api/2/issue/1', site)).toBeNull();
    expect(otherJiraSite('https://antigo.atlassian.net/rest/api/2/issue/1', 'http://127.0.0.1:4100')).toBeNull();
    expect(otherJiraSite('https://antigo.atlassian.net/rest/api/2/issue/1', null)).toBeNull();
  });
});

describe('textos dos avisos (texts.ts, §4.6)', () => {
  const snap = snapOf();
  const created = one('webhook-issue-created');
  const resolved = one('webhook-issue-updated-status-resolution');
  const assigned = one('webhook-issue-assignee');
  const priority = one('webhook-issue-priority');
  const comment = one('webhook-issue-comment');
  const summary = one('webhook-issue-summary');
  const deleted = one('webhook-issue-deleted');

  it('criada', () => {
    expect(eventText('created', created, snap)).toBe(`**Ana Teste** criou ${LINK}: ${SUMMARY}`);
    expect(eventText('created', noActor(created), snap)).toBe(`${LINK} foi criada: ${SUMMARY}`);
  });

  it('criada já com responsável mencionado (§4.5, passo 8): a menção vai no fim', () => {
    expect(eventText('created', created, snap, { mention: 'bruno.teste' })).toBe(`**Ana Teste** criou ${LINK}: ${SUMMARY} (responsável: @bruno.teste)`);
    expect(eventText('created', noActor(created), snap, { mention: 'bruno.teste' })).toBe(`${LINK} foi criada: ${SUMMARY} (responsável: @bruno.teste)`);
  });

  it('status', () => {
    expect(eventText('status', resolved, snap)).toBe(`**Bruno Teste** moveu ${LINK} de **Em andamento** para **Concluído**`);
    expect(eventText('status', noActor(resolved), snap)).toBe(`${LINK} mudou de **Em andamento** para **Concluído**`);
  });

  it('resolvida, com e sem resolução', () => {
    expect(eventText('resolved', resolved, snap)).toBe(`**Bruno Teste** resolveu ${LINK} como **Feito**`);
    expect(eventText('resolved', noActor(resolved), snap)).toBe(`${LINK} foi resolvida como **Feito**`);
    const bare = { ...resolved, changes: [] };
    expect(eventText('resolved', bare, snap)).toBe(`**Bruno Teste** resolveu ${LINK}`);
    expect(eventText('resolved', noActor(bare), snap)).toBe(`${LINK} foi resolvida`);
  });

  it('responsável: para alguém, para si, sem responsável e com menção', () => {
    expect(eventText('assigned', assigned, snap)).toBe(`**Ana Teste** atribuiu ${LINK} a **Bruno Teste**`);
    expect(eventText('assigned', noActor(assigned), snap)).toBe(`${LINK} foi atribuída a **Bruno Teste**`);
    const self = { ...assigned, actor: { accountId: assigned.assignee!.accountId!, displayName: 'Bruno Teste' } };
    expect(eventText('assigned', self, snap)).toBe(`**Bruno Teste** assumiu ${LINK}`);
    expect(eventText('assigned', self, snap, { mention: 'bruno' })).toBe(`**Bruno Teste** assumiu ${LINK}`);
    const none = { ...assigned, assignee: { accountId: null, displayName: null }, changes: [{ field: 'assignee', label: 'Responsável', from: 'Bruno Teste', to: null }] };
    expect(eventText('assigned', none, snap)).toBe(`**Ana Teste** removeu o responsável de ${LINK}`);
    expect(eventText('assigned', noActor(none), snap)).toBe(`${LINK} ficou sem responsável`);
    expect(eventText('assigned', assigned, snap, { mention: 'bruno.teste' })).toBe(`**Ana Teste** atribuiu ${LINK} a @bruno.teste`);
  });

  it('prioridade', () => {
    expect(eventText('priority', priority, snap)).toBe(`**Ana Teste** mudou a prioridade de ${LINK} para **Alta**`);
    expect(eventText('priority', noActor(priority), snap)).toBe(`A prioridade de ${LINK} mudou para **Alta**`);
  });

  it('comentário', () => {
    const c = { ...comment, comment: { ...comment.comment!, text: 'Reiniciei a fila.' } };
    expect(eventText('commented', c, snap)).toBe(`**Bruno Teste** comentou em ${LINK}: “Reiniciei a fila.”`);
    expect(eventText('commented', noActor(c), snap)).toBe(`Novo comentário em ${LINK}: “Reiniciei a fila.”`);
  });

  it('outras alterações, até 3 campos', () => {
    expect(eventText('updated', summary, snap)).toBe(`**Ana Teste** alterou Resumo e Descrição em ${LINK}`);
    expect(eventText('updated', noActor(summary), snap)).toBe(`${LINK} teve Resumo e Descrição alterados`);
    const many = { ...summary, changes: ['Resumo', 'Descrição', 'Rótulos', 'Sprint'].map((label) => ({ field: label, label })) };
    expect(eventText('updated', many, snap)).toBe(`**Ana Teste** alterou 4 campos em ${LINK}`);
    expect(fieldsText(['Resumo', 'Descrição', 'Rótulos'])).toBe('Resumo, Descrição e Rótulos');
  });

  it('excluída usa só a chave', () => {
    expect(eventText('deleted', deleted, snap)).toBe(`**Ana Teste** excluiu OPS-1: ${SUMMARY}`);
    expect(eventText('deleted', noActor(deleted), snap)).toBe(`OPS-1 foi excluída: ${SUMMARY}`);
  });

  it('resumo cortado em 120 caracteres', () => {
    const long = toSnapshot({ ...issueOf('webhook-issue-created'), fields: { ...issueOf('webhook-issue-created').fields, summary: 'x'.repeat(200) } }, ORIGIN);
    const text = eventText('created', noActor(created), long);
    expect(text).toBe(`${LINK} foi criada: ${'x'.repeat(119)}…`);
  });

  it('linhas e títulos do resumo de rajadas', () => {
    expect(digestStatusText(15, ['OPS', 'SUP'], 'Concluído')).toBe('15 issues de OPS e SUP mudaram de status para **Concluído**.');
    expect(digestGenericText(12, ['OPS'])).toBe('12 avisos do Jira em OPS no último minuto.');
    expect(digestLine(snap, shortEventText('status', resolved, snap))).toBe(`${LINK} ${SUMMARY}: **Bruno Teste** moveu de **Em andamento** para **Concluído**`);
    expect(shortEventText('created', noActor(created), snap)).toBe('criada');
    // Excluída: só a chave, sem o link que não abre mais.
    expect(digestLine(snap, shortEventText('deleted', deleted, snap), true)).toBe(`OPS-1 ${SUMMARY}: **Ana Teste** excluiu`);
  });

  it('anúncio e saída da regra, sem @', () => {
    expect(ruleAnnounce(['OPS', 'SUP'], ['created', 'status', 'commented'], 'Operação', 'Ana Souza')).toBe(
      'A partir de agora, o Jira avisa aqui sobre OPS e SUP (issue criada, mudança de status e novo comentário). Regra “Operação”, configurada por Ana Souza.',
    );
    expect(ruleRelease(['OPS'])).toBe('O Jira deixou de avisar aqui sobre OPS.');
    expect(joinList(['A', 'B', 'C'])).toBe('A, B e C');
  });
});

describe('cartões (cards.ts)', () => {
  it('toSnapshot com os campos do cartão, sem avatares nem ícones', () => {
    const issue = fixture('webhook-issue-assignee').issue;
    const snap = toSnapshot(issue, ORIGIN, new Map([['712020:00000000-0000-4000-8000-0000000000b2', 'bruno']]));
    expect(snap).toEqual({
      id: '10001',
      key: 'OPS-1',
      url: `${ORIGIN}/browse/OPS-1`,
      summary: SUMMARY,
      status: { name: 'Tarefas pendentes', category: 'new' },
      type: { name: 'Tarefa', kind: 'task' },
      priority: { name: 'Média' },
      assignee: { accountId: '712020:00000000-0000-4000-8000-0000000000b2', displayName: 'Bruno Teste', username: 'bruno' },
      reporter: { accountId: '712020:00000000-0000-4000-8000-0000000000a1', displayName: 'Ana Teste' },
      project: { key: 'OPS', name: 'Operação' },
      resolution: null,
      updatedAt: '2026-10-22T12:05:00.000Z',
    });
    expect(JSON.stringify(snap)).not.toMatch(/avatar|icon/i);
    expect(toSnapshot(fixture('webhook-issue-comment-jsm-internal').issue, ORIGIN).project.serviceDesk).toBe(true);
    expect(toSnapshot(fixture('webhook-issue-updated-status-resolution').issue, ORIGIN)).toMatchObject({ status: { category: 'done' }, resolution: 'Feito' });
  });

  it('typeKind', () => {
    expect(typeKind({ name: 'Sub-tarefa', subtask: true })).toBe('subtask');
    expect(typeKind({ name: 'Qualquer', hierarchyLevel: -1 })).toBe('subtask');
    expect(typeKind({ name: 'Épico', hierarchyLevel: 1 })).toBe('epic');
    expect(typeKind({ name: 'Bug' })).toBe('bug');
    expect(typeKind({ name: 'Defeito' })).toBe('bug');
    expect(typeKind({ name: 'Erro de sistema' })).toBe('bug');
    expect(typeKind({ name: 'História' })).toBe('story');
    expect(typeKind({ name: 'Story' })).toBe('story');
    expect(typeKind({ name: 'Tarefa' })).toBe('task');
    expect(typeKind({ name: 'Task' })).toBe('task');
    expect(typeKind({ name: 'Solicitação' })).toBe('other');
  });

  it('fallbackAttachment', () => {
    expect(fallbackAttachment(snapOf(fixture('webhook-issue-assignee').issue))).toEqual({
      type: 'jira',
      title: `OPS-1: ${SUMMARY}`,
      title_link: `${ORIGIN}/browse/OPS-1`,
      text: 'Tarefas pendentes · Tarefa · Média · Bruno Teste',
      footer: 'Jira',
    });
    const s = snapOf();
    expect(fallbackAttachment({ ...s, priority: null }).text).toBe('Tarefas pendentes · Tarefa · Sem responsável');
  });

  it('H2: resumo com link disfarçado vira texto no cartão e no anexo', () => {
    const issue = issueOf('webhook-issue-created');
    issue.fields.summary = '[Seu acesso expira, clique aqui](https://evil.example)';
    const snap = toSnapshot(issue, ORIGIN);
    const att = fallbackAttachment(snap);
    for (const s of [snap.summary, att.title!, eventText('created', noActor(one('webhook-issue-created')), snap)]) {
      expect(s).not.toContain('](https://evil.example)');
      expect(s).not.toMatch(/https:\/\/evil\.example/);
      expect(s).toContain('Seu acesso expira, clique aqui');
    }
  });

  it('H3: projeto chamado @all e resumo com @here não viram menção no texto', () => {
    const issue = issueOf('webhook-issue-created');
    issue.fields.summary = 'Avisar @here e #geral';
    issue.fields.project = { ...issue.fields.project, name: '@all' };
    issue.fields.status = { ...issue.fields.status, name: '@all' };
    const snap = toSnapshot(issue, ORIGIN);
    const ev = { ...one('webhook-issue-created'), actor: { displayName: toSnapshot({ fields: { summary: '@all' } }, ORIGIN).summary } };
    const texts = [snap.summary, snap.project.name, snap.status.name, fallbackAttachment(snap).text!, fallbackAttachment(snap).title!, eventText('created', ev, snap)];
    for (const t of texts) expect(t).not.toMatch(/(^|[\s(>"'*])[@#](all|here|geral)\b/);
    expect(snap.summary).toBe(`Avisar @${ZW}here e #${ZW}geral`);
  });
});

describe('campos do formulário (fields.ts)', () => {
  const raw = {
    fields: [
      { key: 'summary', fieldId: 'summary', name: 'Resumo', required: true, schema: { type: 'string', system: 'summary' } },
      { key: 'issuetype', name: 'Tipo', required: true, schema: { type: 'issuetype', system: 'issuetype' } },
      { key: 'project', name: 'Projeto', required: true, schema: { type: 'project', system: 'project' } },
      { key: 'description', name: 'Descrição', required: false, schema: { type: 'string', system: 'description' } },
      { key: 'reporter', name: 'Relator', required: true, hasDefaultValue: true, schema: { type: 'user', system: 'reporter' } },
      { key: 'priority', name: 'Prioridade', required: false, schema: { type: 'priority', system: 'priority' }, allowedValues: [{ id: '2', name: 'Alta' }, { id: '3', name: 'Média' }], defaultValue: { id: '3', name: 'Média' } },
      { key: 'assignee', name: 'Responsável', required: false, schema: { type: 'user', system: 'assignee' } },
      { key: 'customfield_1', name: 'Código do cliente', required: true, schema: { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield' } },
      { key: 'customfield_2', name: 'Detalhes', required: true, schema: { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea' } },
      { key: 'customfield_3', name: 'Ramal', required: true, schema: { type: 'number' } },
      { key: 'customfield_4', name: 'Prazo', required: true, schema: { type: 'date' } },
      { key: 'customfield_5', name: 'Início', required: true, schema: { type: 'datetime' } },
      { key: 'customfield_6', name: 'Turno', required: true, schema: { type: 'option' }, allowedValues: [{ id: '100', value: 'Manhã' }, { id: '101', value: 'Noite' }] },
      { key: 'customfield_7', name: 'Canais', required: true, schema: { type: 'array', items: 'option' }, allowedValues: [{ id: '200', value: 'Voz' }, { id: '201', value: 'Chat' }] },
      { key: 'labels', name: 'Rótulos', required: true, schema: { type: 'array', items: 'string', system: 'labels' } },
      { key: 'customfield_8', name: 'Local', required: true, schema: { type: 'option-with-child' } },
      { key: 'customfield_9', name: 'Equipe', required: true, hasDefaultValue: true, schema: { type: 'team' } },
      { key: 'customfield_10', name: 'Opcional', required: false, schema: { type: 'string' } },
    ],
  };

  it('mapeia cada tipo e lista os obrigatórios que o chat não preenche', () => {
    const { fields, blockers } = mapFields(raw);
    expect(fields.map((f) => [f.key, f.kind, f.required])).toEqual([
      ['priority', 'priority', false],
      ['assignee', 'user', false],
      ['customfield_1', 'string', true],
      ['customfield_2', 'text', true],
      ['customfield_3', 'number', true],
      ['customfield_4', 'date', true],
      ['customfield_5', 'datetime', true],
      ['customfield_6', 'option', true],
      ['customfield_7', 'options', true],
      ['labels', 'labels', true],
    ]);
    expect(fields.find((f) => f.key === 'customfield_6')!.options).toEqual([
      { id: '100', name: 'Manhã' },
      { id: '101', name: 'Noite' },
    ]);
    expect(fields.find((f) => f.key === 'priority')!.defaultValue).toEqual({ id: '3', name: 'Média' });
    expect(blockers).toEqual(['Local']);
    expect(fieldKind({ key: 'x', schema: { type: 'array', items: 'string' } })).toBe('unsupported');
  });

  it('mapeia os tipos de issue sem subtarefas', () => {
    expect(mapIssueTypes({ issueTypes: [{ id: '1', name: 'Bug' }, { id: '2', name: 'Subtarefa', subtask: true }, { id: '3', name: 'Tarefa' }] })).toEqual([
      { id: '1', name: 'Bug', kind: 'bug', subtask: false },
      { id: '3', name: 'Tarefa', kind: 'task', subtask: false },
    ]);
  });

  const { fields } = mapFields(raw);
  const f = (key: string) => fields.find((x) => x.key === key) as JiraFieldMeta;

  it('converte os valores do formulário para o formato do Jira', () => {
    expect(toJiraFieldValue(f('priority'), '2')).toEqual({ id: '2' });
    expect(toJiraFieldValue(f('assignee'), '712020:abc-1')).toEqual({ accountId: '712020:abc-1' });
    expect(toJiraFieldValue(f('assignee'), null)).toBeUndefined();
    expect(toJiraFieldValue(f('customfield_1'), '  C-123 ')).toBe('C-123');
    expect(toJiraFieldValue(f('customfield_2'), 'linha')).toEqual(textToAdf('linha'));
    expect(toJiraFieldValue(f('customfield_3'), '12,5')).toBe(12.5);
    expect(toJiraFieldValue(f('customfield_4'), '2026-10-30')).toBe('2026-10-30');
    expect(toJiraFieldValue(f('customfield_5'), '2026-10-22T14:30:00-03:00')).toBe('2026-10-22T14:30:00.000-0300');
    expect(toJiraFieldValue(f('customfield_6'), '101')).toEqual({ id: '101' });
    expect(toJiraFieldValue(f('customfield_7'), ['200', '201', '200'])).toEqual([{ id: '200' }, { id: '201' }]);
    expect(toJiraFieldValue(f('labels'), ['urgente', 'fila'])).toEqual(['urgente', 'fila']);
  });

  it('recusa valores inválidos com o nome do campo', () => {
    const bad: [string, unknown][] = [
      ['priority', '9'],
      ['assignee', 'tem espaço'],
      ['customfield_1', 'x'.repeat(256)],
      ['customfield_1', ''],
      ['customfield_3', 'abc'],
      ['customfield_4', '2026-02-30'],
      ['customfield_5', '22/10/2026 14:30'],
      ['customfield_6', '999'],
      ['customfield_7', ['200', '999']],
      ['labels', ['com espaço']],
    ];
    for (const [key, value] of bad) {
      let err: any;
      try {
        toJiraFieldValue(f(key), value);
      } catch (e) {
        err = e;
      }
      expect(err?.errorType, key).toBe('error-jira-field');
      expect(err.message).toBe(`Confira o campo ${f(key).name}.`);
    }
    expect(() => toJiraFieldValue({ key: 'x', name: 'Local', required: true, kind: 'unsupported' }, 'a')).toThrow('Confira o campo Local.');
  });
});
