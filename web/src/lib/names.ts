import { useEffect, useState } from 'react';
import { api } from './api';

// Nome de exibição a partir do @usuário, para textos que só trazem o usuário (mensagens de sistema, citações, quem
// digita). Vale primeiro o que já se sabe (autores das mensagens carregadas, membros); o resto vem de users.info,
// uma vez por pessoa.
const names = new Map<string, string>();
const asked = new Set<string>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

// Guarda nomes já conhecidos sem pedir ao servidor.
export function rememberName(username?: string, name?: string) {
  if (username && name && names.get(username) !== name) names.set(username, name);
}

function fetchName(username: string) {
  if (asked.has(username)) return;
  asked.add(username);
  api
    .get('users.info', { username })
    .then((r) => {
      if (r.user?.name) {
        names.set(username, r.user.name);
        emit();
      }
    })
    .catch(() => {});
}

// Nome guardado, ou o próprio @usuário enquanto a busca não volta (e quando a pessoa não existe mais).
export function nameOf(username: string) {
  const known = names.get(username);
  if (known) return known;
  if (username) fetchName(username);
  return username;
}

// O componente volta a renderizar quando chega um nome que ele pediu.
export function useNames() {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((x) => x + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return nameOf;
}

// Troca os @usuário de um texto do servidor (motivos de bloqueio, avisos) pelos nomes de exibição.
export function namesIn(text: string, resolve: (username: string) => string = nameOf) {
  return text.replace(/@([a-zA-Z0-9][\w.\-]*[\w])/g, (all, u: string) => {
    const n = resolve(u);
    return n && n !== u ? n : all;
  });
}
