// Novo papel: em branco, a partir de um modelo de operação ou copiando outro papel. Modelo e cópia levam só o que
// quem cria tem (templatePlan); a delegação do modelo só vem quando quem cria é administrador. O resto se ajusta no
// editor, que abre na aba Permissões.
import { useEffect, useMemo, useRef, useState } from 'react';
import { RBAC_TEMPLATES, rbacLabel, roleNameProblem, templatePlan, VISIBLE_KEYS, type RbacTemplate, type RoleInfo } from '@shared/rbac';
import { ROLE_LABEL, roleDisplayName } from '@shared/messageText';
import { api } from '../../../lib/api';
import { nameList, plural, roleLabel } from '../../../lib/format';
import { Icon } from '../../../components/Icon';
import { useIsPhone } from '../../../components/overlay';
import { Field, Modal, Segmented } from '../../../components/ui';
import { rbacFail, rbacOk, type Grant, type RbacRole } from './data';

type Start = 'blank' | 'template' | 'copy';
const NAME_MAX = 32;
const PURPOSE_MAX = 200;

const infoOf = (r: RbacRole): RoleInfo => ({ id: r._id, scope: r.scope, protected: !!r.protected, root: !!r.root, permissions: r.permissions, delegable: r.delegable ?? [] });

const nameRoles = (roles: RbacRole[]) => roles.map((r) => ({ id: r._id, description: r.description }));
const problemOf = (id: string, label: string, roles: RbacRole[]) =>
  roleNameProblem(id, label, nameRoles(roles), ROLE_LABEL, { isNew: true, displayName: roleDisplayName });

// Identificador livre: o do modelo, ou com -2, -3… se já existir (sem maiúsculas e pontuação, como o servidor confere).
function freeId(base: string, roles: RbacRole[]) {
  if (!problemOf(base, '', roles)) return base;
  let i = 2;
  while (problemOf(`${base}-${i}`, '', roles)) i++;
  return `${base}-${i}`;
}

// Nome exibido livre: o do modelo, ou com 2, 3… se outro papel já aparece com ele.
function freeLabel(id: string, base: string, roles: RbacRole[]) {
  if (problemOf(id, base, roles)?.code !== 'RBAC_DUPLICATE_ROLE_LABEL') return base;
  let i = 2;
  while (problemOf(id, `${base} ${i}`.slice(0, NAME_MAX), roles)?.code === 'RBAC_DUPLICATE_ROLE_LABEL' && i < 50) i++;
  return `${base} ${i}`.slice(0, NAME_MAX);
}

export function CreateRole({ source, roles, grant, onClose, onCreated }: { source?: RbacRole; roles: RbacRole[]; grant: Grant; onClose: () => void; onCreated: (id: string) => void }) {
  const phone = useIsPhone();
  const [start, setStart] = useState<Start>(source ? 'copy' : 'blank');
  const [tplId, setTplId] = useState<string | null>(null);
  const [copyId, setCopyId] = useState(source?._id ?? '');
  const [name, setName] = useState(source ? freeId(`${source._id}-copia`, roles) : '');
  const [label, setLabel] = useState(source ? freeLabel(name, `Cópia de ${roleLabel(source._id)}`.slice(0, NAME_MAX), roles) : '');
  const [purpose, setPurpose] = useState(source?.purpose ?? '');
  const [scope, setScope] = useState<'Users' | 'Subscriptions'>(source?.scope ?? 'Users');
  const [busy, setBusy] = useState(false);
  const infos = useMemo(() => roles.map(infoOf), [roles]);
  const tpl = start === 'template' ? RBAC_TEMPLATES.find((t) => t.id === tplId) : undefined;
  const copy = start === 'copy' ? roles.find((r) => r._id === copyId) : undefined;

  // O que vai junto: chaves, as que ficam de fora, e a delegação.
  const plan = useMemo(() => {
    if (tpl) return templatePlan(tpl, grant, infos);
    if (copy) {
      const held = new Set(grant.held);
      const keys = copy.permissions.filter((k) => grant.root || held.has(k));
      return { keys, stripped: copy.permissions.filter((k) => !keys.includes(k) && VISIBLE_KEYS.includes(k)), delegable: [], delegationSkipped: [] };
    }
    return null;
  }, [tpl, copy, grant, infos]);

  // Ao escolher um modelo, o cartão escolhido (com o plano dentro) fica à vista.
  const cardsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (tplId) cardsRef.current?.querySelector<HTMLElement>('.rbac-template-card.on')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [tplId]);

  const pickTemplate = (t: RbacTemplate) => {
    setTplId(t.id);
    const id = freeId(t.id, roles);
    setName(id);
    setLabel(freeLabel(id, t.label, roles));
    setPurpose(t.description);
    setScope(t.scope);
  };
  const pickCopy = (id: string) => {
    setCopyId(id);
    const r = roles.find((x) => x._id === id);
    if (!r) return;
    const next = freeId(`${r._id}-copia`, roles);
    setName(next);
    setLabel(freeLabel(next, `Cópia de ${roleLabel(r._id)}`.slice(0, NAME_MAX), roles));
    setPurpose(r.purpose ?? '');
    setScope(r.scope);
  };
  const changeStart = (s: Start) => {
    setStart(s);
    if (s === 'copy' && !copyId && roles.length) pickCopy(roles.find((r) => !r.root)?._id ?? roles[0]._id);
  };

  // As mesmas regras do servidor: o identificador e o nome exibido não se passam por outro papel.
  const problem = name.trim() ? problemOf(name.trim(), label.trim(), roles) : null;
  const valid = !!name.trim() && !problem && (start !== 'template' || !!tpl) && (start !== 'copy' || !!copy);
  const create = async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { name: name.trim(), description: label.trim(), purpose: purpose.trim(), scope };
      if (tpl) Object.assign(body, { mandatory2fa: tpl.mandatory2fa, restrictDirect: tpl.scope === 'Users' && tpl.restrictDirect });
      if (copy) Object.assign(body, { mandatory2fa: copy.mandatory2fa, restrictDirect: scope === 'Users' && copy.restrictDirect });
      if (plan) body.permissions = grant.canEditPermissions ? plan.keys : [];
      if (plan?.delegable.length) body.delegable = plan.delegable;
      await api.post('rbac.roles.create', body);
      rbacOk(`Papel ${label.trim() || name.trim()} criado.`);
      onCreated(name.trim());
    } catch (e) {
      rbacFail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      size="sm"
      variant={phone ? 'sheet' : undefined}
      title={source ? `Duplicar ${roleLabel(source._id)}` : 'Novo papel'}
      description="Depois de criar, você ajusta as permissões no editor."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={busy || !valid} aria-busy={busy || undefined} onClick={() => void create()}>
            Criar e abrir
          </button>
        </>
      }
    >
      <div className="form">
        <div className="field">
          <span className="field-label">Começar de</span>
          <Segmented<Start>
            label="Começar de"
            value={start}
            onChange={changeStart}
            items={[
              { id: 'blank', label: 'Em branco' },
              { id: 'template', label: 'Modelo', icon: 'rbac-template' },
              { id: 'copy', label: 'Copiar papel', icon: 'rbac-duplicate' },
            ]}
          />
        </div>
        {start === 'template' && (
          <div className="rbac-templates" role="radiogroup" aria-label="Modelos" ref={cardsRef}>
            {RBAC_TEMPLATES.map((t) => (
              <button key={t.id} type="button" role="radio" aria-checked={tplId === t.id} className={`rbac-template-card${tplId === t.id ? ' on' : ''}`} onClick={() => pickTemplate(t)}>
                <span className="rbac-template-name">
                  <Icon name="rbac-template" size={14} />
                  {t.label}
                </span>
                <span className="rbac-template-desc">{t.description}</span>
                <span className="rbac-template-tags">
                  {t.mandatory2fa && <span className="pill tag">2FA obrigatório</span>}
                  {t.restrictDirect && (
                    <span className="pill warn tag">
                      <Icon name="direct-blocked" size={12} />
                      Restrito
                    </span>
                  )}
                  <span className="muted small">{plural(t.keys.length, 'permissão', 'permissões')}</span>
                </span>
                {/* O plano no próprio cartão: o que vai junto aparece no clique, sem rolar até o fim. */}
                {tplId === t.id && plan && <PlanSummary plan={plan} canEdit={grant.canEditPermissions} />}
              </button>
            ))}
          </div>
        )}
        {start === 'copy' && (
          <Field label="Papel de origem">
            <select value={copyId} onChange={(e) => pickCopy(e.target.value)}>
              {roles.map((r) => (
                <option key={r._id} value={r._id}>
                  {roleLabel(r._id)}
                  {r.scope === 'Subscriptions' ? ' (de sala)' : ''}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Identificador" hint="Sem acentos, ex.: supervisor. Não muda depois." error={problem && problem.code !== 'RBAC_DUPLICATE_ROLE_LABEL' ? problem.error : undefined}>
          <input value={name} autoFocus={start === 'blank'} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Nome exibido" hint={`Até ${NAME_MAX} caracteres. ${label.length}/${NAME_MAX}`} error={problem?.code === 'RBAC_DUPLICATE_ROLE_LABEL' ? problem.error : undefined}>
          <input value={label} maxLength={NAME_MAX} placeholder="Supervisor de operação" onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Para que serve" hint={`Uma frase simples. Aparece embaixo do nome. ${purpose.length}/${PURPOSE_MAX}`}>
          <textarea rows={Math.max(2, Math.min(5, Math.ceil(purpose.length / 56)))} value={purpose} maxLength={PURPOSE_MAX} onChange={(e) => setPurpose(e.target.value)} />
        </Field>
        <Field label="Escopo">
          <select value={scope} disabled={!!tpl} onChange={(e) => setScope(e.target.value as 'Users' | 'Subscriptions')}>
            <option value="Users">Global: vale em todo o chat</option>
            <option value="Subscriptions">De sala: vale só nas salas onde a pessoa tem o papel</option>
          </select>
        </Field>
        {plan && !tpl && (
          <div className="rbac-create-plan">
            <PlanSummary plan={plan} canEdit={grant.canEditPermissions} />
          </div>
        )}
      </div>
    </Modal>
  );
}

type Plan = ReturnType<typeof templatePlan>;

// O que o papel leva ao nascer: quantas permissões, as que ficam de fora (você não tem) e a delegação.
function PlanSummary({ plan, canEdit }: { plan: Plan; canEdit: boolean }) {
  return (
    <span className="rbac-plan" role="status">
      {!canEdit ? (
        <span>O papel nasce sem permissões: você não altera permissões.</span>
      ) : (
        <>
          <span>Leva {plural(plan.keys.length, 'permissão', 'permissões')}.</span>
          {plan.stripped.length > 0 && (
            <span className="muted">
              {plan.stripped.length === 1 ? '1 fica de fora porque você não a tem' : `${plan.stripped.length} ficam de fora porque você não as tem`}: {plan.stripped.slice(0, 3).map(rbacLabel).join(', ')}
              {plan.stripped.length > 3 ? '…' : '.'}
            </span>
          )}
        </>
      )}
      {plan.delegable.length > 0 && <span>Já vem com a delegação: quem tiver o papel pode dar {nameList(plan.delegable.map(roleLabel), 3)}.</span>}
      {plan.delegationSkipped.length > 0 && <span className="muted">A delegação de {nameList(plan.delegationSkipped.map(roleLabel), 3)} só um administrador define.</span>}
    </span>
  );
}
