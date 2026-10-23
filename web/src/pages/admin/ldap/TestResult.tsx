import { Fragment, type ReactNode } from 'react';
import { ouLabel, type LdapMappingTest } from '@shared/ldap';
import { roleLabel } from '../../../lib/format';
import { Icon } from '../../../components/Icon';
import { Avatar } from '../../../components/ui';
import { originOf } from './mapping-model';

const ACTION: Record<LdapMappingTest['account']['action'], string> = {
  create: 'Será criada',
  update: 'Será atualizada',
  skip: 'Não será importada',
  conflict: 'Conflito',
};

function List({ items, prefix = '', cls = '', empty = '—', team }: { items: string[]; prefix?: string; cls?: string; empty?: string; team?: boolean }) {
  if (!items.length) return <span className="muted">{empty}</span>;
  return (
    <span className="chips">
      {items.map((i) => (
        <span key={i} className={`chip ldap-chip ${cls}`}>
          {team && <Icon name="room-team" size={14} />}
          {prefix}
          {i}
        </span>
      ))}
    </span>
  );
}

// DN quebra de linha só depois das vírgulas, nunca no meio de um nome.
export function DnText({ dn }: { dn: string }) {
  const parts = dn.split(',');
  return (
    <span className="mono small ldap-dn-text">
      {parts.map((x, i) => (
        <Fragment key={i}>
          {x}
          {i < parts.length - 1 && (
            <>
              ,<wbr />
            </>
          )}
        </Fragment>
      ))}
    </span>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ldap-kv-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Section({ title, children, wide }: { title: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <section className={`card ldap-result-card ${wide ? 'wide' : ''}`}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export function TestResult({ r, draft }: { r: LdapMappingTest; draft: boolean }) {
  if (!r.found || !r.entry)
    return (
      <div className="ldap-result">
        <div className="callout warn ldap-result-wide">
          <Icon name="warning" />
          <span>{r.message ?? `Nenhuma entrada encontrada para "${r.login}".`}</span>
        </div>
        {r.warnings.length > 0 && <Warnings list={r.warnings} />}
      </div>
    );

  const e = r.entry;
  const a = r.account;
  return (
    <div className="ldap-result" aria-live="polite">
      <p className="muted small ldap-result-wide ldap-result-lead">
        Prévia para <strong>{r.login}</strong>
        {draft ? ', com as alterações não salvas.' : ', com as configurações salvas.'}
      </p>

      <Section title="Entrada">
        <div className="ldap-entry">
          {e.photo ? (
            <img className="ldap-photo" src={e.photo} alt="" width={56} height={56} />
          ) : (
            <span className="ldap-photo none">
              <Avatar username={e.username} size={56} />
            </span>
          )}
          <div className="ldap-entry-main">
            <strong>{e.name}</strong>
            <span className="muted">@{e.username}</span>
            {e.disabled && <span className="neg ldap-strong">Conta desativada no AD</span>}
          </div>
        </div>
        <dl className="ldap-kv">
          <Row label="E-mail">{e.email ?? <span className="muted">—</span>}</Row>
          <Row label="DN">
            <DnText dn={e.dn} />
          </Row>
          <Row label="OU">{ouLabel(e.parentDn) || <span className="muted">—</span>}</Row>
          {e.guid && (
            <Row label="GUID">
              <span className="mono small ldap-break">{e.guid}</span>
            </Row>
          )}
        </dl>
      </Section>

      <Section title={`Grupos (${r.groups.length})`}>
        {r.groups.length ? (
          <div className="chips">
            {r.groups.map((g) => (
              <span key={g.dn} className="chip ldap-chip" title={g.dn}>
                <Icon name="ldap-group" size={14} />
                {g.cn}
              </span>
            ))}
          </div>
        ) : (
          <span className="muted">{r.groupError ? 'Os grupos não puderam ser lidos.' : 'Não está em nenhum grupo da base de grupos.'}</span>
        )}
        <p className="muted small">{r.nestedApplied ? 'Grupos aninhados: incluídos' : 'Grupos aninhados: não incluídos'}</p>
        {r.groupError && <p className="neg small">{r.groupError}</p>}
      </Section>

      <Section title="Regras que se aplicam" wide>
        {r.matched.length ? (
          <ul className="ldap-matched">
            {r.matched.map((m) => {
              const o = originOf(m.key);
              return (
                <li key={m.key}>
                  <span className="ldap-matched-origin" title={o.title}>
                    <Icon name={o.icon} size={16} />
                    <strong>{o.label}</strong>
                  </span>
                  <span className="ldap-matched-values">
                    {m.roles.length > 0 && <List items={m.roles} />}
                    {m.channels.length > 0 && <List items={m.channels} prefix="#" />}
                    {m.teams.length > 0 && <List items={m.teams} team />}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <span className="muted">Nenhuma regra do mapeamento se aplica a esta pessoa.</span>
        )}
      </Section>

      <Section title="Conta">
        <p className="ldap-account">
          <span className={`pill ldap-run ${a.action === 'conflict' ? 'failed' : a.action === 'skip' ? 'partial' : 'success'}`}>{ACTION[a.action]}</span>
          <span className={a.activeAfter ? 'pos' : 'neg'}>{a.activeAfter ? 'Ficará ativa' : 'Ficará desativada'}</span>
        </p>
        {a.note && <p className={a.action === 'conflict' ? 'neg small' : 'muted small'}>{a.note}</p>}
        {a.exists && a.username && (
          <p className="muted small">
            Conta atual: @{a.username} ({a.active ? 'ativa' : 'desativada'})
          </p>
        )}
      </Section>

      <Section title="Papéis">
        <div className="ldap-roles-change">
          <List items={r.roles.before.map(roleLabel)} empty="nenhum" />
          <span className="muted ldap-arrow" role="img" aria-label="passa a ser">
            <Icon name="changes-to" size={16} />
          </span>
          <List items={r.roles.after.map(roleLabel)} empty="nenhum" />
        </div>
        {(r.roles.added.length > 0 || r.roles.removed.length > 0) && (
          <div className="chips ldap-diff">
            {r.roles.added.map((x) => (
              <span key={`+${x}`} className="chip ldap-chip add">
                +{roleLabel(x)}
              </span>
            ))}
            {r.roles.removed.map((x) => (
              <span key={`-${x}`} className="chip ldap-chip del">
                −{roleLabel(x)}
              </span>
            ))}
          </div>
        )}
        {!r.roles.added.length && !r.roles.removed.length && <p className="muted small">Os papéis não mudam.</p>}
      </Section>

      <Section title="Canais">
        <dl className="ldap-kv">
          <Row label="Entra em">
            <List items={r.channels.join} prefix="#" />
          </Row>
          <Row label="Sai de">
            <List items={r.channels.leave} prefix="#" cls="del" />
          </Row>
          <Row label="Serão criados">
            <List items={r.channels.create} prefix="#" cls="new" />
          </Row>
        </dl>
      </Section>

      <Section title="Times">
        <dl className="ldap-kv">
          <Row label="Entra em">
            <List items={r.teams.join} />
          </Row>
          <Row label="Sai de">
            <List items={r.teams.leave} cls="del" />
          </Row>
          <Row label="Não existem">
            <List items={r.teams.missing} cls="bad" />
          </Row>
        </dl>
      </Section>

      <Section title="Conversas diretas">
        <p>
          Restrito em conversas diretas: <strong>{r.direct.restricted ? 'sim' : 'não'}</strong>
          {r.direct.exempt && <span className="muted"> (com permissão para conversar com outros restritos)</span>}
        </p>
      </Section>

      <Warnings list={r.warnings} />
    </div>
  );
}

function Warnings({ list }: { list: string[] }) {
  return (
    <Section title={`Avisos (${list.length})`} wide>
      {list.length ? (
        <ul className="ldap-warnings">
          {list.map((w, i) => (
            <li key={i}>
              <Icon name="warning" size={14} />
              {w}
            </li>
          ))}
        </ul>
      ) : (
        <span className="muted">Nenhum aviso.</span>
      )}
    </Section>
  );
}
