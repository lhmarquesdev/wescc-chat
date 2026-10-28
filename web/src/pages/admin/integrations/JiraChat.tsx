// Integrações (Jira/Teams): Jira → Recursos no chat (§7.3): prévias, projetos visíveis, criação de issues e quem usa.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { JiraProjectRef } from '@shared/integrations';
import { roleLabel } from '../../../lib/format';
import { usePermission } from '../../../lib/store';
import { Icon } from '../../../components/Icon';
import { Skeleton, Toggle, useAsync } from '../../../components/ui';
import { jiraAdmin, permissionsApi } from './admin-api';
import type { JiraTabProps } from './JiraAdmin';
import { ChipInput, SaveBar, SettingRow, TabBody, done, fail, projectKey, useDraft, useUnsavedGuard, type ChipSuggestion } from './parts';
import './integrations-admin.css';

interface Form {
  unfurlEnabled: boolean;
  unfurlMax: number;
  projectsVisible: string[];
  projectsCreate: string[];
  defaultProject: string;
}

const projectLabel = (p: JiraProjectRef) => (
  <span>
    <span className="mono">{p.key}</span> · {p.name}
  </span>
);

const WHO = [
  { perm: 'use-jira', label: 'Usar o Jira no chat' },
  { perm: 'create-jira-issue', label: 'Criar issues do Jira' },
];

export function JiraChat({ config, onConfig, onDirty }: JiraTabProps) {
  const f = useDraft<Form>({
    unfurlEnabled: config.unfurlEnabled,
    unfurlMax: config.unfurlMax,
    projectsVisible: config.projectsVisible,
    projectsCreate: config.projectsCreate,
    defaultProject: config.defaultProject,
  });
  const [saving, setSaving] = useState(false);
  const canPerms = usePermission('access-permissions');
  // Lista de projetos para as sugestões e o projeto sugerido; precisa do Jira ligado e de use-jira (senão, digita-se a chave).
  const projects = useAsync(() => jiraAdmin.projects().then((r) => r.projects), [config.enabled]);
  const perms = useAsync(() => permissionsApi.list().then((r) => r.update), []);
  const dirty = f.changed.length > 0;
  useUnsavedGuard(dirty);
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  const suggest = useCallback(async (q: string): Promise<ChipSuggestion[]> => {
    const r = await jiraAdmin.projects(q);
    return r.projects.map((p) => ({ value: p.key, label: projectLabel(p) }));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const r = await jiraAdmin.save(Object.fromEntries(f.changed.map((k) => [k, f.get(k)])));
      onConfig(r.config);
      f.reset();
      done('Alterações salvas.');
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  };

  const create = f.get('projectsCreate');
  const current = f.get('defaultProject');
  // Projeto sugerido: entre os de criação, ou entre todos quando a lista de criação está vazia.
  const choices: { key: string; name?: string }[] = create.length ? create.map((k) => ({ key: k, name: projects.data?.find((p) => p.key === k)?.name })) : (projects.data ?? []).map((p) => ({ key: p.key, name: p.name }));
  if (current && !choices.some((c) => c.key === current)) choices.unshift({ key: current });
  const freeText = !create.length && !projects.data;
  const nameOf = (k: string) => projects.data?.find((p) => p.key === k)?.name;

  return (
    <>
      <TabBody>
        {/* Sem título: logo depois das abas, com o mesmo espaço das outras abas. */}
        <section aria-label="Recursos no chat">
          <SettingRow label="Prévias de issues" modified={f.isChanged('unfurlEnabled')}>
            <Toggle checked={f.get('unfurlEnabled')} onChange={(v) => f.set('unfurlEnabled', v)} label="Mostrar prévia das issues citadas nas mensagens" />
          </SettingRow>
          <SettingRow label="Prévias por mensagem" htmlFor="jira-unfurl-max" modified={f.isChanged('unfurlMax')}>
            <select id="jira-unfurl-max" value={f.get('unfurlMax')} disabled={!f.get('unfurlEnabled')} onChange={(e) => f.set('unfurlMax', Number(e.target.value))}>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </SettingRow>
          <SettingRow
            label="Projetos visíveis para toda a empresa"
            htmlFor="jira-projects-visible"
            modified={f.isChanged('projectsVisible')}
            help="Também limita o que /jira mostra para quem não conectou a conta. Issues com nível de segurança nunca aparecem."
          >
            <div className="channel-list">
              <ChipInput
                inputId="jira-projects-visible"
                label="Projetos visíveis para toda a empresa"
                value={f.get('projectsVisible')}
                onChange={(v) => f.set('projectsVisible', v)}
                normalize={projectKey}
                mono
                placeholder="Ex.: OPS"
                suggest={suggest}
                chipTitle={nameOf}
              />
              <div className="callout warn">
                <Icon name="warning" />
                <span>
                  A prévia mostra título, status, tipo, prioridade e responsável para todos que veem a mensagem, mesmo quem não tem acesso ao Jira. Inclua só projetos que todos da empresa podem ver.
                </span>
              </div>
            </div>
          </SettingRow>
          <SettingRow
            label="Projetos em que o chat cria issues"
            htmlFor="jira-projects-create"
            modified={f.isChanged('projectsCreate')}
            help="Vazio = todos em que a pessoa (ou a conta da integração) pode criar."
          >
            <div className="channel-list">
              <ChipInput
                inputId="jira-projects-create"
                label="Projetos em que o chat cria issues"
                value={create}
                onChange={(v) => f.set('projectsCreate', v)}
                normalize={projectKey}
                mono
                placeholder="Ex.: OPS"
                suggest={suggest}
                chipTitle={nameOf}
              />
            </div>
          </SettingRow>
          <SettingRow label="Projeto sugerido" htmlFor="jira-default-project" modified={f.isChanged('defaultProject')}>
            {freeText ? (
              <input
                id="jira-default-project"
                spellCheck={false}
                placeholder="Ex.: OPS"
                value={current}
                onChange={(e) => f.set('defaultProject', projectKey(e.target.value))}
              />
            ) : (
              <select id="jira-default-project" value={current} onChange={(e) => f.set('defaultProject', e.target.value)}>
                <option value="">Nenhum</option>
                {choices.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.name ? `${c.key} · ${c.name}` : c.key}
                  </option>
                ))}
              </select>
            )}
          </SettingRow>
          <SettingRow label="Quem pode usar">
            {perms.loading && !perms.data ? (
              <Skeleton width={240} height={14} />
            ) : perms.data ? (
              WHO.map((w) => {
                const roles = perms.data?.find((p) => p._id === w.perm)?.roles ?? [];
                return (
                  <span key={w.perm}>
                    {w.label} — <span className="muted">{roles.length ? roles.map(roleLabel).join(', ') : 'ninguém'}</span>
                  </span>
                );
              })
            ) : (
              <span className="muted small">Não foi possível ler as permissões.</span>
            )}
            {/* Botão pequeno: no celular a área de toque chega a 44 px (um link de texto teria 16). */}
            {canPerms && (
              <Link to="/admin/permissions" className="btn small">
                Alterar em Papéis e permissões
              </Link>
            )}
          </SettingRow>
        </section>
      </TabBody>
      <SaveBar count={f.changed.length} saving={saving} onDiscard={f.reset} onSave={() => void save()} />
    </>
  );
}
