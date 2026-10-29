// Resumo da política de conversas diretas restritas (papel Operação e afins) e das brechas: papéis que deixam
// pessoas restritas abrir salas privadas entre si.
import type { DirectRestrictionReport } from '@shared/direct';
import { rbacLabel } from '@shared/rbac';
import { nameList, roleLabel } from '../../../lib/format';
import { Icon } from '../../../components/Icon';
import { SkeletonTable } from '../../../components/ui';

const EXEMPT_PERMISSION = 'start-dm-between-restricted';

// O que cada brecha deixa criar ("criar grupos privados, times e discussões").
const LOOPHOLE_WHAT: Record<string, string> = {
  'create-p': 'grupos privados',
  'create-team': 'times',
  'start-discussion': 'discussões',
  'start-discussion-other-user': 'discussões',
};

const people = (n: number) => `${n} ${n === 1 ? 'pessoa' : 'pessoas'}`;

// Resumo da política de conversas diretas e das brechas (papéis que deixam pessoas restritas abrir salas privadas).
export function DirectReportCard({ state, onFix }: { state: { data: DirectRestrictionReport | null; loading: boolean; error: string | null }; onFix: (role: string) => void }) {
  const { data: r, loading, error } = state;
  if (loading && !r)
    return (
      <div className="card direct-report">
        <SkeletonTable rows={3} cols={3} />
      </div>
    );
  if (error || !r) return <div className="card direct-report muted small">Não foi possível carregar o resumo das conversas diretas restritas{error ? `: ${error}` : '.'}</div>;
  if (!r.restrictedRoles.length)
    return (
      <div className="card direct-report">
        <h3>Conversas diretas restritas</h3>
        <p className="muted">Nenhum papel está restrito em conversas diretas.</p>
      </div>
    );
  // As brechas viram um aviso só (criar grupos privados, times e discussões costumam vir do mesmo papel e das mesmas
  // pessoas). start-discussion e start-discussion-other-user contam como uma ação.
  const what = new Set<string>();
  const other = new Set<string>();
  const viaRoles = new Set<string>();
  const sample = new Map<string, string>();
  const counts = new Set<number>();
  for (const l of r.loopholes) {
    if (LOOPHOLE_WHAT[l.permission]) what.add(LOOPHOLE_WHAT[l.permission]);
    else other.add(rbacLabel(l.permission).toLowerCase());
    l.viaRoles.forEach((x) => viaRoles.add(x));
    l.sample.forEach((u) => sample.size < 10 && sample.set(u._id, u.username));
    counts.add(l.users);
  }
  // Contagens diferentes por ação: o número de uma não vale para as outras.
  const one = counts.size === 1 ? [...counts][0] : 0;
  const who = one ? `${people(one)} com papel restrito ainda ${one === 1 ? 'pode' : 'podem'}` : 'Pessoas com papel restrito ainda podem';
  const via = [...viaRoles].map(roleLabel);
  const actions = [...(what.size ? [`criar ${nameList([...what], 3)}`] : []), ...other];
  return (
    <div className="card direct-report">
      <h3>Conversas diretas restritas</h3>
      <p>Papéis restritos: {r.restrictedRoles.map((x) => `${roleLabel(x._id)} (${people(x.users)})`).join(', ')}.</p>
      <p>{r.scope === 'same_role' ? 'Regra: pessoas com o mesmo papel restrito não conversam em particular.' : 'Regra: duas pessoas com papel restrito não conversam em particular.'}</p>
      <p>
        Exceção (permissão {rbacLabel(EXEMPT_PERMISSION)}, <code className="mono">{EXEMPT_PERMISSION}</code>): {r.exemptRoles.length ? r.exemptRoles.map(roleLabel).join(', ') : 'ninguém'}.
      </p>
      {actions.length > 0 && (
        <div className="callout warn">
          <Icon name="warning" />
          <span>
            {who} {nameList(actions, 3)} pelo {via.length === 1 ? 'papel' : 'papéis'} {nameList(via, 3)}, o que abre conversas particulares fora das mensagens diretas. Tire o
            papel dessas pessoas ou as permissões do papel.
            <span className="callout-sample">{[...sample.values()].map((u) => `@${u}`).join(', ')}</span>
          </span>
          {via.length > 0 && (
            <button className="btn small" onClick={() => onFix([...viaRoles][0])}>
              Abrir {via[0]}
            </button>
          )}
        </div>
      )}
      {r.blockedDirects > 0 && (
        <p className="muted small">
          {r.blockedDirects === 1
            ? '1 conversa direta antiga está bloqueada (o histórico continua disponível).'
            : `${r.blockedDirects} conversas diretas antigas estão bloqueadas (o histórico continua disponível).`}
        </p>
      )}
    </div>
  );
}
