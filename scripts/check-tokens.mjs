// Confere web/src/styles/tokens.css: o bloco @supports not (light-dark) tem de repetir o primeiro argumento (tema claro)
// de cada light-dark(), e só tokens que existem. Uso: node scripts/check-tokens.mjs [arquivo] (sai com 1 se algo divergir).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../web/src/styles/tokens.css');
const css = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const norm = (v) => v.trim().replace(/\s+/g, ' ').toLowerCase();

const at = css.indexOf('@supports not');
if (at < 0) throw new Error('bloco @supports not (light-dark) não encontrado');
const fallback = Object.fromEntries([...css.slice(at).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], norm(m[2])]));

// Primeiro argumento de light-dark(), respeitando parênteses de rgb().
function lightValue(v) {
  const i = v.indexOf('light-dark(');
  let depth = 0;
  for (let j = i + 'light-dark('.length; j < v.length; j++) {
    if (v[j] === '(') depth++;
    else if (v[j] === ')') depth--;
    else if (v[j] === ',' && depth === 0) return norm(v.slice(i + 'light-dark('.length, j));
  }
  throw new Error(`light-dark() sem vírgula: ${v}`);
}

const root = css.slice(css.indexOf(':root'), at);
const themed = {};
for (const m of root.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) if (m[2].includes('light-dark(') && !(m[1] in themed)) themed[m[1]] = m[2];

const errors = [];
for (const [name, value] of Object.entries(themed)) {
  const want = value.trim().startsWith('light-dark(') ? lightValue(value) : null;
  if (want === null) continue; // light-dark() dentro de outro valor (ex.: --highlight-top) tem fallback próprio
  if (!(name in fallback)) errors.push(`${name}: falta no bloco @supports (esperado ${want})`);
  else if (fallback[name] !== want) errors.push(`${name}: @supports tem ${fallback[name]}, light-dark() tem ${want}`);
}
for (const name of Object.keys(fallback)) if (!(name in themed)) errors.push(`${name}: está no @supports mas não usa light-dark()`);

if (errors.length) {
  console.error(`tokens.css: ${errors.length} divergência(s)\n  ${errors.join('\n  ')}`);
  process.exit(1);
}
console.log(`tokens.css ok: ${Object.keys(fallback).length} valores de fallback conferidos`);
