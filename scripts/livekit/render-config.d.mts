// Tipos de render-config.mjs, para os testes em TypeScript.
export interface RenderOptions {
  nodeIp: string;
  lanCidr: string | string[];
  apiKey: string;
  secretFile: string;
  webhookUrl: string;
  cores: number | string;
  maxMbps: number | string;
  /** num_tracks fixo (100 a 100000); sem ele, 400 por processador, até 8000. */
  maxTracks?: number | string | null;
  warn?: (message: string) => void;
}

export interface RenderArgs extends Partial<Omit<RenderOptions, 'lanCidr' | 'warn'>> {
  lanCidr?: string[];
  out?: string;
  help?: boolean;
}

export const TEMPLATE_FILE: string;
export const DEFAULT_WEBHOOK_URL: string;
export const DEFAULT_MAX_MBPS: number;
export const USAGE: string;
export function parseIpv4(v: string): number[] | null;
export function isPrivateIpv4(v: string): boolean;
export function readSecretFile(file: string): string;
export function renderConfig(o: RenderOptions): string;
export function parseArgs(argv: string[]): RenderArgs;
export function main(argv?: string[]): number;
