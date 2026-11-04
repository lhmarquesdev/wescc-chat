// Log do servidor para os serviços (o app.log do Fastify, ligado em app.ts). Antes de ligar, e nos testes que não
// sobem o app, não escreve nada.
export interface AppLog {
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}
let current: AppLog = { warn() {}, error() {} };
export const appLog: AppLog = {
  warn: (obj, msg) => current.warn(obj, msg),
  error: (obj, msg) => current.error(obj, msg),
};
export function useAppLog(l: AppLog) {
  current = l;
}
