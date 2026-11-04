// Nome de um dispositivo de login para mostrar (Minha conta › Dispositivos, Administração, o e-mail de acesso novo e
// Meus dados). O servidor monta "Chrome em Windows"; um programa que não é navegador (script, curl) ou sem User-Agent
// vira "Navegador ou aplicativo desconhecido", com o sistema quando se sabe. Nunca "Outro em Desconhecido".
export interface DeviceLike {
  name?: string | null;
  os?: string | null;
  browser?: string | null;
}

const UNKNOWN = 'Navegador ou aplicativo desconhecido';

export function deviceLabel(d: DeviceLike): string {
  const name = String(d.name ?? '').trim();
  const os = d.os && d.os !== 'Desconhecido' ? d.os : '';
  const unknownBrowser = d.browser === 'Outro' || d.browser === 'API' || /^(Outro|API)?\s*em\s+Desconhecido$/i.test(name) || /^(Outro|API)\b/.test(name);
  if (!name || unknownBrowser) return os ? `${UNKNOWN} em ${os}` : UNKNOWN;
  return name.replace(/ em Desconhecido$/, '');
}
