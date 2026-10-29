// Integrações (Jira/Teams): criar ou editar uma regra de avisos do Jira (§7.3). Salva direto (jira.rules.save);
// a prévia usa jira.rules.preview, que não publica nada.
import { useCallback, useId, useState, type FormEvent } from 'react';
import { JIRA_DEFAULT_EVENTS, JIRA_EVENT_KINDS, JIRA_EVENT_LABEL, type JiraConfig, type JiraEventKind, type JiraRule, type JiraRuleInput, type MessageJira } from '@shared/integrations';
import { errorMessage } from '../../../lib/api';
import { renderMarkdown } from '../../../lib/markdown';
import { Icon } from '../../../components/Icon';
import { JiraCard } from '../../../components/integrations/JiraCard';
import { Modal, Spinner, Toggle, confirmDialog } from '../../../components/ui';
import { jiraAdmin } from './admin-api';
import { ChipInput, FieldBlock, FormError, done, projectKey, useInvalid, type ChipSuggestion, type Invalid } from './parts';
import { RoomTargets } from './RoomTargets';
import './integrations-admin.css';

// Os mesmos textos e limites do servidor (RULE_TEXT): o erro aparece antes de ir e voltar.
const RULE_TEXT = {
  name: 'Dê um nome à regra (até 80 caracteres).',
  projects: 'Escolha de 1 a 20 projetos.',
  events: 'Escolha pelo menos um tipo de aviso.',
  jqlLong: 'O filtro JQL tem um erro: use no máximo 1000 caracteres.',
  rooms: 'Escolha de 1 a 5 salas.',
};
const SD_TITLE = 'Projeto de atendimento a clientes';

const empty = (): JiraRuleInput => ({
  name: '',
  enabled: true,
  projects: [],
  issueTypes: [],
  events: [...JIRA_DEFAULT_EVENTS],
  jql: '',
  roomIds: [],
  threads: true,
  mentionAssignee: false,
  grantPublisher: false,
});

type Field = 'name' | 'projects' | 'events' | 'jql' | 'rooms';

function validate(f: JiraRuleInput): Invalid<Field> | null {
  const name = f.name.trim();
  if (!name || name.length > 80) return { field: 'name', text: RULE_TEXT.name };
  if (!f.projects.length || f.projects.length > 20) return { field: 'projects', text: RULE_TEXT.projects };
  if (!f.events.length) return { field: 'events', text: RULE_TEXT.events };
  if (f.jql.length > 1000) return { field: 'jql', text: RULE_TEXT.jqlLong };
  if (!f.roomIds.length || f.roomIds.length > 5) return { field: 'rooms', text: RULE_TEXT.rooms };
  return null;
}

export function JiraRuleModal({ rule, config, onClose, onSaved }: { rule: JiraRule | null; config: JiraConfig; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<JiraRuleInput>(() =>
    rule
      ? {
          name: rule.name,
          enabled: rule.enabled,
          projects: rule.projects,
          issueTypes: rule.issueTypes,
          events: rule.events,
          jql: rule.jql,
          roomIds: rule.roomIds,
          threads: rule.threads,
          mentionAssignee: rule.mentionAssignee,
          grantPublisher: rule.grantPublisher,
        }
      : empty(),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{ msg: string; jira: MessageJira } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  // Projetos do Service Management: os vistos no último teste e os que a busca de projetos marcar.
  const [serviceDesk, setServiceDesk] = useState<string[]>(config.serviceDeskProjects);
  const formId = useId();
  const ids = { name: useId(), projects: useId(), types: useId(), jql: useId(), events: useId(), rooms: useId() };
  // Erro de um campo: marcado e com o foco nele; o erro do servidor continua no fim (FormError).
  const v = useInvalid<Field>({ name: ids.name, projects: ids.projects, events: ids.events, jql: ids.jql, rooms: ids.rooms });
  const FIELD_OF: Partial<Record<keyof JiraRuleInput, Field>> = { name: 'name', projects: 'projects', events: 'events', jql: 'jql', roomIds: 'rooms' };
  const set = <K extends keyof JiraRuleInput>(k: K, val: JiraRuleInput[K]) => {
    setF((cur) => ({ ...cur, [k]: val }));
    setError(null);
    const field = FIELD_OF[k];
    if (field) v.clear(field);
  };

  const suggest = useCallback(async (q: string): Promise<ChipSuggestion[]> => {
    const r = await jiraAdmin.projects(q);
    const sd = r.projects.filter((p) => p.serviceDesk).map((p) => p.key);
    if (sd.length) setServiceDesk((cur) => [...new Set([...cur, ...sd])]);
    return r.projects.map((p) => ({
      value: p.key,
      label: (
        <span>
          <span className="mono">{p.key}</span> · {p.name}
        </span>
      ),
    }));
  }, []);

  const toggleEvent = (k: JiraEventKind, on: boolean) => {
    const next = on ? [...f.events, k] : f.events.filter((e) => e !== k);
    // Mantém a ordem da lista, a mesma do servidor.
    set(
      'events',
      JIRA_EVENT_KINDS.filter((e) => next.includes(e)),
    );
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = validate(f);
    if (problem) {
      setError(null);
      v.show(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await jiraAdmin.saveRule({ ...f, name: f.name.trim(), jql: f.jql.trim(), ...(rule ? { _id: rule._id } : {}) });
      done(rule ? 'Regra salva.' : 'Regra criada.');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!rule) return;
    const yes = await confirmDialog({
      title: `Excluir a regra “${rule.name}”?`,
      body: 'O Jira deixa de avisar nas salas desta regra e sai das que nenhuma outra regra usa.',
      confirmLabel: 'Excluir',
      danger: true,
    });
    if (!yes) return;
    setSaving(true);
    try {
      await jiraAdmin.removeRule(rule._id);
      done('Regra excluída.');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  };

  const showPreview = async () => {
    if (!f.projects.length) {
      setPreviewError(RULE_TEXT.projects);
      setPreview(null);
      return;
    }
    setPreviewing(true);
    setPreviewError(null);
    try {
      setPreview(await jiraAdmin.preview(f.projects, f.events));
    } catch (err) {
      setPreview(null);
      setPreviewError(errorMessage(err));
    } finally {
      setPreviewing(false);
    }
  };

  const sdChosen = f.projects.some((p) => serviceDesk.includes(p));
  const polling = config.eventsMode === 'polling';

  return (
    <Modal
      size="lg"
      title={rule ? 'Editar regra' : 'Nova regra de avisos'}
      onClose={onClose}
      footer={
        <>
          {rule && (
            <button type="button" className="btn danger" disabled={saving} onClick={remove}>
              <Icon name="delete" />
              Excluir regra
            </button>
          )}
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" form={formId} className="btn primary" disabled={saving} aria-busy={saving || undefined}>
            {rule ? 'Salvar regra' : 'Criar regra'}
          </button>
        </>
      }
    >
      <form id={formId} className="form" onSubmit={submit} noValidate>
        <FieldBlock label="Nome" htmlFor={ids.name} error={v.error('name')} errorId={v.errorId('name')}>
          <input id={ids.name} value={f.name} maxLength={80} placeholder="Ex.: Incidentes da operação" {...v.aria('name')} onChange={(e) => set('name', e.target.value)} />
        </FieldBlock>

        <FieldBlock label="Projetos" htmlFor={ids.projects} hint="Até 20 projetos." error={v.error('projects')} errorId={v.errorId('projects')}>
          <ChipInput
            inputId={ids.projects}
            label="Projetos"
            value={f.projects}
            onChange={(v) => set('projects', v)}
            max={20}
            normalize={projectKey}
            mono
            placeholder="Ex.: OPS"
            suggest={suggest}
            chipTitle={(k) => (serviceDesk.includes(k) ? SD_TITLE : undefined)}
            invalid={v.aria('projects')}
          />
        </FieldBlock>
        {/* Depois da dica do campo, para "Até 20 projetos." ficar colado no campo. */}
        {sdChosen && (
          <div className="callout warn">
            <Icon name="warning" />
            <span>Este projeto é de atendimento. Os avisos podem trazer dados de clientes para o chat.</span>
          </div>
        )}

        <FieldBlock label="Tipos de issue" htmlFor={ids.types} hint="Vazio = todos os tipos.">
          <ChipInput inputId={ids.types} label="Tipos de issue" value={f.issueTypes} onChange={(v) => set('issueTypes', v)} max={20} placeholder="Ex.: Bug, Incidente" />
        </FieldBlock>

        <FieldBlock label="Avisar quando" error={v.error('events')} errorId={v.errorId('events')}>
          <div className="check-list">
            {JIRA_EVENT_KINDS.map((k, i) => (
              <label key={k} className="check">
                <input
                  type="checkbox"
                  id={i === 0 ? ids.events : undefined}
                  checked={f.events.includes(k)}
                  {...(i === 0 ? v.aria('events') : {})}
                  onChange={(e) => toggleEvent(k, e.target.checked)}
                />
                <span>
                  {JIRA_EVENT_LABEL[k]}
                  {k === 'deleted' && polling && <span className="muted"> (só com webhook)</span>}
                </span>
              </label>
            ))}
          </div>
        </FieldBlock>

        <FieldBlock label="Filtro JQL (opcional)" htmlFor={ids.jql} hint="Só avisa issues que também atendem a este filtro." error={v.error('jql')} errorId={v.errorId('jql')}>
          <textarea
            id={ids.jql}
            className="mono"
            rows={2}
            spellCheck={false}
            maxLength={1000}
            placeholder="priority in (Highest, High)"
            value={f.jql}
            {...v.aria('jql')}
            onChange={(e) => set('jql', e.target.value)}
          />
        </FieldBlock>

        <FieldBlock label="Salas" hint="O robô Jira entra nas salas escolhidas, e todos veem quem configurou a regra." error={v.error('rooms')} errorId={v.errorId('rooms')}>
          <RoomTargets
            inputId={ids.rooms}
            invalid={v.aria('rooms')}
            provider="jira"
            mode="post"
            max={5}
            value={f.roomIds}
            onChange={(v) => set('roomIds', v)}
            grantPublisher={f.grantPublisher}
            onGrantPublisher={(v) => set('grantPublisher', v)}
            known={rule?.rooms}
          />
        </FieldBlock>

        <Toggle
          checked={f.threads}
          onChange={(v) => set('threads', v)}
          label="Agrupar por issue em tópicos"
          description="O primeiro aviso de cada issue fica no canal e os seguintes vão para o tópico dele. Resolvidas e excluídas também aparecem no canal. Muitas mudanças no mesmo minuto viram um resumo."
        />
        <Toggle
          checked={f.mentionAssignee}
          onChange={(v) => set('mentionAssignee', v)}
          label="Mencionar o responsável"
          description="Quem conectou a conta do Jira é mencionado quando uma issue é atribuída a ele. Nenhuma outra menção é feita pelo robô."
        />
        <Toggle checked={f.enabled} onChange={(v) => set('enabled', v)} label="Regra ativada" />

        <div className="row-actions wrap">
          <button type="button" className="btn small ghost" disabled={previewing} onClick={showPreview}>
            {previewing ? <Spinner size="sm" /> : <Icon name="show" />}
            Ver prévia
          </button>
        </div>
        {previewError && (
          <div className="form-error" role="alert">
            <Icon name="error" size={16} />
            <span>{previewError}</span>
          </div>
        )}
        {preview && (
          <section className="card" aria-live="polite" aria-labelledby={`${formId}-preview`}>
            <div className="card-head">
              <h3 className="sub-title" id={`${formId}-preview`}>
                Assim vai aparecer na sala
              </h3>
            </div>
            <div className="msg-body">{renderMarkdown(preview.msg)}</div>
            <JiraCard jira={preview.jira} compact={false} />
          </section>
        )}

        {error && <FormError text={error} />}
      </form>
    </Modal>
  );
}
