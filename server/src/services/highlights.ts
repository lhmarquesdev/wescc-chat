// Palavras destacadas na hora do envio: quem da sala tem uma delas na mensagem conta e é avisado como numa menção.
// Nada fica gravado por mensagem (a retenção não precisa saber disso).
import { compileHighlights, findHighlight, type HighlightMatcher } from '@shared/highlights';
import { many } from '../db/pool';

// As expressões compiladas de cada lista de palavras (muita gente tem as mesmas, como "plantão").
const cache = new Map<string, HighlightMatcher | null>();
const CACHE_MAX = 500;

function matcherFor(words: string[]) {
  const key = words.join('\u0000');
  let m = cache.get(key);
  if (m === undefined) {
    if (cache.size >= CACHE_MAX) cache.clear();
    m = compileHighlights(words);
    cache.set(key, m);
  }
  return m;
}

// Quem da sala tem palavra destacada na mensagem (menos quem escreveu). Map userId -> palavra (como a pessoa escreveu).
// text é o mesmo texto em que as menções são procuradas.
export async function highlightedMembers(rid: string, senderId: string, text: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!text) return out;
  const rows = await many(
    `SELECT s.user_id, u.preferences->'highlights' AS words
     FROM subscriptions s JOIN users u ON u.id = s.user_id
     WHERE s.room_id = $1 AND s.user_id <> $2 AND u.active
       AND jsonb_typeof(u.preferences->'highlights') = 'array' AND jsonb_array_length(u.preferences->'highlights') > 0`,
    [rid, senderId],
  );
  for (const r of rows) {
    const word = findHighlight(text, matcherFor((r.words as unknown[]).filter((w): w is string => typeof w === 'string')));
    if (word) out.set(r.user_id, word);
  }
  return out;
}
