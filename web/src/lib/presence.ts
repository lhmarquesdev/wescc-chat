import { useMemo } from 'react';
import { compileHighlights, type HighlightMatcher } from '@shared/highlights';
import type { UserStatus } from '@shared/index';
import { presenceLabel, shownCustomStatus } from '@shared/status';
import { useStore } from './store';

// Presença de uma pessoa com o rótulo pronto: o nome do status personalizado ("Em reunião") enquanto o status real é
// o tipo dele; senão o rótulo de base. A presença ao vivo vale por cima do que a tela buscou (fallback).
// (Não é o usePresence de ui.tsx, que cuida da animação de saída das camadas.)
export function useUserPresence(username?: string, fallback?: { status?: UserStatus | string; statusCustom?: string | null }) {
  const live = useStore((s) => (username ? s.presence[username] : undefined));
  const list = useStore((s) => s.userStatuses);
  const status = (live?.status ?? fallback?.status ?? 'offline') as UserStatus;
  const statusCustom = live ? live.statusCustom ?? null : fallback?.statusCustom ?? null;
  return { status, statusCustom, label: presenceLabel({ status, statusCustom }, list), custom: !!shownCustomStatus({ status, statusCustom }, list) };
}

// As palavras destacadas de quem está usando, compiladas uma vez por lista.
export function useHighlights(): HighlightMatcher | null {
  const key = useStore((s) => {
    const w = s.me?.preferences?.highlights;
    return Array.isArray(w) ? w.join('\u0000') : '';
  });
  return useMemo(() => (key ? compileHighlights(key.split('\u0000')) : null), [key]);
}
