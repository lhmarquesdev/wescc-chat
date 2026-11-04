// A mensagem como a tela usa: em conversa criptografada, msg vira o texto decifrado e e2eView diz o estado.
import { useMemo } from 'react';
import type { Message } from '@shared/index';
import { useE2e, viewOf, type E2eView } from './client';

export function useE2eMessage<T extends Message>(m: T): T & { e2eView?: E2eView } {
  const version = useE2e((s) => (m.e2e ? s.version : 0));
  const status = useE2e((s) => (m.e2e ? s.status : null));
  return useMemo(() => {
    if (!m.e2e) return m;
    const view = viewOf(m)!;
    return { ...m, msg: view.state === 'ok' ? (view.content?.msg ?? '') : '', e2eView: view };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m, version, status]);
}
