// Ponto único de montagem das chamadas (App.tsx): chamada recebida, tela de entrada, janela e camada da chamada
// (CallRoot) e o aviso de nova versão do chat (VersionPrompt).
import { CallRoot } from './call/CallRoot';
import { VersionPrompt } from './call/VersionPrompt';

export function CallOverlay() {
  return (
    <>
      <CallRoot />
      <VersionPrompt />
    </>
  );
}
