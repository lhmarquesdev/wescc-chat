import { csvImporter } from './importers/csv';
import { slackUsersImporter } from './importers/slack-users';
import { slackImporter } from './importers/slack';
import type { Importer } from './types';

// Ordem da lista na tela "Nova importação".
export const importers: Importer[] = [csvImporter, slackImporter, slackUsersImporter];

export function getImporter(key: string): Importer | null {
  return importers.find((i) => i.key === key) ?? null;
}

// Importações sem arquivo (API e downloads posteriores) não têm importador na lista.
const OTHER_NAMES: Record<string, string> = {
  api: 'API',
  'pending-files': 'Arquivos pendentes',
  'pending-avatars': 'Fotos pendentes',
};

export function importerName(key: string): string {
  return OTHER_NAMES[key] ?? getImporter(key)?.name ?? key;
}
