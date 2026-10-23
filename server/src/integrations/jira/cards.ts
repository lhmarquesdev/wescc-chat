// JiraIssueSnapshot e anexo de reserva a partir de uma issue (puro).
import type { Attachment } from '@shared/index';
import type { JiraIssueSnapshot, JiraPerson, JiraStatusCategory, JiraTypeKind } from '@shared/integrations';
import { safeExternalText } from '../text';
import { cut } from './texts';

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function typeKind(issueType: { name?: string; subtask?: boolean; hierarchyLevel?: number }): JiraTypeKind {
  if (issueType?.subtask || issueType?.hierarchyLevel === -1) return 'subtask';
  if (issueType?.hierarchyLevel === 1) return 'epic';
  const n = fold(String(issueType?.name ?? ''));
  if (/bug|defeito|erro/.test(n)) return 'bug';
  if (/historia|story/.test(n)) return 'story';
  if (/tarefa|task/.test(n)) return 'task';
  return 'other';
}

const category = (key: unknown): JiraStatusCategory => (key === 'indeterminate' || key === 'done' ? key : 'new');

function personOf(p: any, people?: Map<string, string>): JiraPerson | null {
  if (!p || typeof p !== 'object' || (!p.displayName && !p.accountId)) return null;
  const out: JiraPerson = { displayName: safeExternalText(String(p.displayName ?? '')) };
  if (p.accountId) {
    out.accountId = String(p.accountId);
    const u = people?.get(out.accountId);
    if (u) out.username = u;
  }
  return out;
}

const iso = (v: unknown) => {
  const d = v ? new Date(String(v)) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : new Date(0).toISOString();
};

// Cartão a partir da issue (campos de ISSUE_FIELDS). Nunca guarda avatares nem ícones do Jira: pediriam login no Jira.
export function toSnapshot(issue: any, origin: string, people?: Map<string, string>): JiraIssueSnapshot {
  const f = issue?.fields ?? {};
  const key = String(issue?.key ?? '');
  const project = f.project ?? {};
  return {
    id: String(issue?.id ?? ''),
    key,
    url: `${origin}/browse/${encodeURIComponent(key)}`,
    summary: safeExternalText(String(f.summary ?? '')),
    status: { name: safeExternalText(String(f.status?.name ?? '')), category: category(f.status?.statusCategory?.key) },
    type: { name: safeExternalText(String(f.issuetype?.name ?? '')), kind: typeKind(f.issuetype ?? {}) },
    priority: f.priority?.name ? { name: safeExternalText(String(f.priority.name)) } : null,
    assignee: personOf(f.assignee, people),
    reporter: personOf(f.reporter, people),
    project: {
      key: String(project.key ?? key.slice(0, key.lastIndexOf('-'))),
      name: safeExternalText(String(project.name ?? project.key ?? '')),
      ...(project.projectTypeKey === 'service_desk' ? { serviceDesk: true } : {}),
    },
    resolution: f.resolution?.name ? safeExternalText(String(f.resolution.name)) : null,
    updatedAt: iso(f.updated ?? f.created),
  };
}

// Anexo simples para clientes antigos, push, e-mail e busca. A web nova o esconde quando message.jira existe.
export function fallbackAttachment(s: JiraIssueSnapshot): Attachment {
  const parts = [s.status.name, s.type.name, s.priority?.name, s.assignee?.displayName || 'Sem responsável'].filter((x): x is string => !!x);
  return { type: 'jira', title: `${s.key}: ${cut(s.summary, 120)}`, title_link: s.url, text: parts.join(' · '), footer: 'Jira' };
}
