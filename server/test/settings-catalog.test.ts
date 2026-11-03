import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listSettings } from '../src/services/settings';

// Toda opção da Administração precisa mudar alguma coisa: uma chave que só existe no catálogo é um botão que engana
// (como "Criptografia ponta a ponta", que ligava sem cifrar nada).
const ROOT = join(__dirname, '..', '..');
function files(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !p.endsWith(join('services', 'settings.ts'))) out.push(p);
  }
  return out;
}

describe('catálogo de configurações', () => {
  it('nenhuma configuração decorativa', () => {
    const code = [join(ROOT, 'server', 'src'), join(ROOT, 'web', 'src'), join(ROOT, 'shared', 'src')]
      .flatMap((d) => files(d))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    const ids = listSettings().map((s) => s._id);
    expect(ids.length).toBeGreaterThan(100);
    expect(ids.filter((id) => !code.includes(id))).toEqual([]);
  });
});
