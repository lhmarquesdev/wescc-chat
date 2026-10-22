import type { Readable } from 'node:stream';
import { ImportError, ST, type ImportContact, type Importer, type PrepareContext } from '../types';
import { RowIssues, byteProgress, csvTable, isBlankRow, openSingleCsv, semicolonError, semicolonSeparated, splitList } from './csv-util';

type Column = 'name' | 'emails' | 'phones' | 'manager' | 'id';

// Nomes de coluna aceitos (sem diferença de maiúsculas); qualquer outra coluna vira campo personalizado.
const COLUMNS: Record<string, Column> = {
  name: 'name',
  nome: 'name',
  emails: 'emails',
  email: 'emails',
  'e-mail': 'emails',
  'e-mails': 'emails',
  phones: 'phones',
  phone: 'phones',
  telefone: 'phones',
  telefones: 'phones',
  manager: 'manager',
  gerente: 'manager',
  responsavel: 'manager',
  'responsável': 'manager',
  id: 'id',
};

const EMPTY = ['linha sem nome, e-mail e telefone ignorada', 'linhas sem nome, e-mail e telefone ignoradas'] as const;
const REPEATED = ['contato repetido ignorado (vale a primeira linha)', 'contatos repetidos ignorados (vale a primeira linha)'] as const;

interface Header {
  index: Partial<Record<Column, number>>;
  custom: [string, number][];
}

function readHeader(fields: string[], file: string): Header {
  if (semicolonSeparated(fields, 2)) throw semicolonError(file);
  const index: Partial<Record<Column, number>> = {};
  const custom: [string, number][] = [];
  fields.forEach((h, i) => {
    const key = h.trim();
    if (!key) return;
    const col = COLUMNS[key.toLowerCase()];
    if (col) index[col] ??= i;
    else if (!custom.some(([k]) => k === key)) custom.push([key, i]);
  });
  if (index.name === undefined && index.emails === undefined && index.phones === undefined) {
    throw new ImportError(`"${file}" precisa de uma primeira linha de cabeçalho com as colunas name, emails e phones (e, se quiser, manager, id e outras colunas para campos personalizados).`);
  }
  return { index, custom };
}

// Lê um .csv de contatos (com cabeçalho), linha a linha, e entrega cada contato a ctx.contact. Devolve quantos foram lidos.
// Usado pelo importador de contatos e pelo contacts.csv dentro do .zip do importador CSV.
export async function parseContactsCsv(input: Readable | Buffer, ctx: PrepareContext, file = 'contacts.csv', onBytes?: (n: number) => void): Promise<number> {
  let head: Header | null = null;
  const issues = new RowIssues();
  const seen = new Set<string>();
  let count = 0;
  for await (const row of csvTable(input, file, { warn: (m) => ctx.warn(m), onBytes })) {
    if (isBlankRow(row.fields)) continue;
    if (!head) {
      head = readHeader(row.fields, file);
      continue;
    }
    if (ctx.cancelled()) return count;
    const { index, custom } = head;
    const get = (i: number | undefined) => (i === undefined ? '' : (row.fields[i] ?? '').trim());
    const name = get(index.name);
    const emails = splitList(get(index.emails));
    const phones = splitList(get(index.phones));
    if (!name && !emails.length && !phones.length) {
      issues.add(EMPTY, row.line);
      continue;
    }
    const importId = get(index.id) || (emails.length ? `contact:${emails[0].toLowerCase()}` : phones.length ? `contact:${phones[0].replace(/[^\d+]/g, '') || phones[0]}` : `contact:row${row.line}`);
    if (seen.has(importId)) {
      issues.add(REPEATED, row.line);
      continue;
    }
    seen.add(importId);
    const rec: ImportContact = { importIds: [importId], emails, phones };
    if (name) rec.name = name;
    const manager = get(index.manager);
    if (manager) rec.manager = manager;
    const fields: Record<string, string> = {};
    for (const [key, i] of custom) {
      const v = get(i);
      if (v) fields[key] = v;
    }
    if (Object.keys(fields).length) rec.customFields = fields;
    await ctx.contact(rec);
    count++;
  }
  if (!head) {
    ctx.warn(`"${file}" está vazio.`);
    return 0;
  }
  issues.flush((m) => ctx.warn(m), file);
  return count;
}

export const contactsImporter: Importer = {
  key: 'omnichannel_contact',
  name: 'Contatos do omnichannel',
  label: 'Contatos do omnichannel (.csv)',
  description:
    'Um .csv com cabeçalho e as colunas name, emails, phones, manager e id. Vários e-mails ou telefones vão separados por ponto e vírgula; as outras colunas viram campos personalizados do contato.',
  accept: '.csv',
  sourceKind: 'file',
  visible: true,
  async prepare(ctx) {
    const { name, size, stream } = await openSingleCsv(ctx);
    await ctx.setStep(ST.preparingContacts);
    ctx.progress(0);
    await parseContactsCsv(stream, ctx, name, byteProgress(ctx, size));
    ctx.progress(100);
  },
};
