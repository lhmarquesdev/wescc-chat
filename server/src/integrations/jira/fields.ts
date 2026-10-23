// Campos do createmeta → JiraFieldMeta; valor do formulário → valor do Jira (puro).
import type { JiraFieldKind, JiraFieldMeta, JiraIssueTypeMeta } from '@shared/integrations';
import { badRequest } from '../../lib/errors';
import { textToAdf } from './adf';
import { typeKind } from './cards';
import { ISSUE_TEXT } from './texts';

const TEXTAREA = 'com.atlassian.jira.plugin.system.customfieldtypes:textarea';
const LABELS = 'com.atlassian.jira.plugin.system.customfieldtypes:labels';
// Preenchidos pelo próprio formulário ou pelo Jira: nunca viram campo extra nem bloqueio.
const HANDLED = new Set(['project', 'issuetype', 'summary', 'description']);

export function fieldKind(f: any): JiraFieldKind {
  const key = String(f?.key ?? f?.fieldId ?? '');
  const s = f?.schema ?? {};
  if (key === 'priority' || s.type === 'priority') return 'priority';
  if (s.type === 'user' || key === 'assignee') return 'user';
  if (s.type === 'string') return s.custom === TEXTAREA || s.system === 'environment' ? 'text' : 'string';
  if (s.type === 'number') return 'number';
  if (s.type === 'date') return 'date';
  if (s.type === 'datetime') return 'datetime';
  if (s.type === 'option') return 'option';
  if (s.type === 'array' && s.items === 'option') return 'options';
  if (s.type === 'array' && s.items === 'string' && (s.system === 'labels' || s.custom === LABELS || key === 'labels')) return 'labels';
  return 'unsupported';
}

const optionList = (f: any) =>
  Array.isArray(f?.allowedValues) ? f.allowedValues.filter((v: any) => v?.id).map((v: any) => ({ id: String(v.id), name: String(v.name ?? v.value ?? v.id) })) : undefined;

// Lista de campos de um tipo (GET …/createmeta/{projeto}/issuetypes/{id}) → o que o formulário mostra e o que bloqueia.
export function mapFields(raw: any): { fields: JiraFieldMeta[]; blockers: string[] } {
  const list: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.fields) ? raw.fields : Array.isArray(raw?.values) ? raw.values : [];
  const fields: JiraFieldMeta[] = [];
  const blockers: string[] = [];
  for (const f of list) {
    const key = String(f?.key ?? f?.fieldId ?? '');
    if (!key || HANDLED.has(key)) continue;
    const kind = fieldKind(f);
    const required = !!f.required;
    const hasDefault = !!f.hasDefaultValue || f.defaultValue !== undefined;
    const always = key === 'priority' || key === 'assignee';
    if (kind === 'unsupported') {
      if (required && !hasDefault) blockers.push(String(f.name ?? key));
      continue;
    }
    if (!always && !required) continue;
    if (key === 'reporter' && hasDefault) continue;
    const meta: JiraFieldMeta = { key, name: String(f.name ?? key), required, kind };
    const options = kind === 'option' || kind === 'options' || kind === 'priority' ? optionList(f) : undefined;
    if (options) meta.options = options;
    if (f.defaultValue !== undefined) meta.defaultValue = f.defaultValue;
    fields.push(meta);
  }
  return { fields, blockers };
}

// Tipos de issue do createmeta (GET …/createmeta/{projeto}/issuetypes), sem subtarefas.
export function mapIssueTypes(raw: any): JiraIssueTypeMeta[] {
  const list: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.issueTypes) ? raw.issueTypes : Array.isArray(raw?.values) ? raw.values : [];
  return list
    .filter((t) => t?.id && !t.subtask)
    .map((t) => ({ id: String(t.id), name: String(t.name ?? ''), kind: typeKind(t), subtask: false }));
}

const empty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const fail = (meta: JiraFieldMeta) => badRequest('error-jira-field', ISSUE_TEXT.field(meta.name));

function validDate(s: string) {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// "2026-10-22T14:30:00-03:00" (localIso) → "2026-10-22T14:30:00.000-0300", o formato que o Jira documenta.
function jiraDateTime(s: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})$/.exec(s);
  if (!m || !validDate(m[1]) || Number(m[2]) > 23 || Number(m[3]) > 59 || Number(m[4] ?? 0) > 59) return null;
  const off = m[6] === 'Z' ? '+0000' : m[6].replace(':', '');
  return `${m[1]}T${m[2]}:${m[3]}:${m[4] ?? '00'}.${(m[5] ?? '000').padEnd(3, '0')}${off}`;
}

// Valor do formulário → valor que o Jira espera. undefined: campo opcional vazio (não vai para o Jira).
export function toJiraFieldValue(meta: JiraFieldMeta, value: unknown): unknown {
  if (empty(value)) {
    if (meta.required && meta.defaultValue === undefined) throw fail(meta);
    return undefined;
  }
  const ids = new Set((meta.options ?? []).map((o) => o.id));
  const known = (id: string) => !meta.options || ids.has(id);
  switch (meta.kind) {
    case 'priority':
    case 'option': {
      const id = typeof value === 'object' && value ? String((value as any).id ?? '') : String(value);
      if (!id || !known(id)) throw fail(meta);
      return { id };
    }
    case 'user': {
      const id = typeof value === 'object' && value ? String((value as any).accountId ?? '') : String(value);
      if (!/^[A-Za-z0-9:_-]{1,128}$/.test(id)) throw fail(meta);
      return { accountId: id };
    }
    case 'string': {
      if (typeof value !== 'string' || [...value].length > 255) throw fail(meta);
      const s = value.trim();
      if (!s && meta.required) throw fail(meta);
      return s || undefined;
    }
    case 'text': {
      if (typeof value !== 'string' || value.length > 32000) throw fail(meta);
      if (!value.trim() && meta.required) throw fail(meta);
      return value.trim() ? textToAdf(value) : undefined;
    }
    case 'number': {
      const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value.replace(',', '.')) : NaN;
      if (!Number.isFinite(n)) throw fail(meta);
      return n;
    }
    case 'date': {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !validDate(value)) throw fail(meta);
      return value;
    }
    case 'datetime': {
      const v = typeof value === 'string' ? jiraDateTime(value.trim()) : null;
      if (!v) throw fail(meta);
      return v;
    }
    case 'options': {
      const list = Array.isArray(value) ? value : [value];
      const out = list.map((v) => (typeof v === 'object' && v ? String((v as any).id ?? '') : String(v)));
      if (out.length > 100 || out.some((id) => !id || !known(id))) throw fail(meta);
      return [...new Set(out)].map((id) => ({ id }));
    }
    case 'labels': {
      const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : null;
      if (!list) throw fail(meta);
      const out = list.map((v) => String(v).trim()).filter(Boolean);
      if (out.length > 100 || out.some((l) => /\s/.test(l) || l.length > 255)) throw fail(meta);
      if (!out.length && meta.required) throw fail(meta);
      return out.length ? [...new Set(out)] : undefined;
    }
    default:
      throw fail(meta);
  }
}
