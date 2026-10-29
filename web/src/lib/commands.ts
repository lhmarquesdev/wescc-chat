// Comandos de barra (/) das sugestões do compositor: a lista de commands.list, guardada por usuário. O servidor filtra
// a lista por pessoa (/jira e /teams aparecem com a integração ligada e a permissão), então ela vale só para quem a
// buscou e é buscada de novo quando as integrações, as permissões ou os papéis mudam, ao reconectar, ao entrar e ao sair
// (lib/session.ts).
import { api } from './api';

export interface SlashCommand {
  command: string;
  params: string;
  description: string;
}

let cache: { uid: string; list: Promise<SlashCommand[]> } | null = null;

export function slashCommands(uid: string): Promise<SlashCommand[]> {
  if (cache?.uid === uid) return cache.list;
  const entry: { uid: string; list: Promise<SlashCommand[]> } = {
    uid,
    list: api
      .get<{ commands: SlashCommand[] }>('commands.list')
      .then((r) => r.commands)
      .catch(() => {
        // Falhou (sem conexão): a próxima barra digitada pergunta de novo, em vez de ficar sem comandos.
        if (cache === entry) cache = null;
        return [];
      }),
  };
  cache = entry;
  return entry.list;
}

export function invalidateSlashCommands() {
  cache = null;
}
