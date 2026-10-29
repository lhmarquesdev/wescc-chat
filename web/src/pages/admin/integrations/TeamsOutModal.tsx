// Integrações (Jira/Teams): criar ou editar uma regra de envio para o Teams (§7.4). O endereço do fluxo é segredo:
// nunca volta do servidor, só o final.
import { useId, useState, type FormEvent } from 'react';
import type { TeamsConfig, TeamsOutFilter, TeamsOutRule, TeamsOutRuleInput } from '@shared/integrations';
import { errorMessage } from '../../../lib/api';
import { useSetting } from '../../../lib/store';
import { Icon } from '../../../components/Icon';
import { Modal, Toggle, confirmDialog } from '../../../components/ui';
import { teamsAdmin } from './admin-api';
import { ChipInput, Disclosure, FieldBlock, FormError, Radio, done, useInvalid, type Invalid } from './parts';
import { RoomTargets } from './RoomTargets';
import { SecretField } from './SecretField';
import './integrations-admin.css';

// Os mesmos textos do servidor (OUT_TEXT): o erro aparece antes de ir e voltar.
const OUT_TEXT = {
  name: 'Dê um nome à regra (até 80 caracteres).',
  workflowsUrl: 'Use o endereço do fluxo do Workflows (Power Automate). Ele termina em .environment.api.powerplatform.com.',
  rooms: 'Escolha de 1 a 10 salas.',
  keywords: 'Informe de 1 a 20 palavras-chave.',
  destination: 'Diga para onde vão as mensagens, por exemplo Operação › Avisos.',
  flowOwner: 'Informe o e-mail da conta dona do fluxo no Power Automate.',
  noOid: '(configure o aplicativo do Entra na aba Conexão)',
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BUDGETS = [5, 10, 20] as const;
const FILTERS: { id: TeamsOutFilter; label: string }[] = [
  { id: 'root', label: 'Só as mensagens principais' },
  { id: 'all', label: 'Todas, inclusive respostas em tópicos' },
  { id: 'ack', label: 'Só os avisos com “Ciente”' },
  { id: 'keywords', label: 'Só as que têm palavras-chave' },
];

type Form = Omit<TeamsOutRuleInput, 'url'> & { url: string | null | undefined };
type Field = 'name' | 'url' | 'rooms' | 'keywords' | 'destination' | 'flowOwner';
const FIELD_OF: Partial<Record<keyof Form, Field>> = { name: 'name', url: 'url', roomIds: 'rooms', keywords: 'keywords', filter: 'keywords', destinationLabel: 'destination', flowOwner: 'flowOwner' };

const empty = (): Form => ({
  name: '',
  enabled: true,
  roomIds: [],
  filter: 'root',
  keywords: [],
  includeBots: false,
  includeFiles: true,
  includeLink: true,
  destinationLabel: '',
  destinationPrivate: false,
  flowOwner: '',
  budget: 20,
  auth: 'none',
  url: undefined,
});

// Na ordem dos campos no formulário: o primeiro que falta é o que recebe o foco.
function validate(f: Form, isNew: boolean): Invalid<Field> | null {
  const name = f.name.trim();
  if (!name || name.length > 80) return { field: 'name', text: OUT_TEXT.name };
  if (!f.roomIds.length || f.roomIds.length > 10) return { field: 'rooms', text: OUT_TEXT.rooms };
  if (f.filter === 'keywords' && (!f.keywords.length || f.keywords.length > 20)) return { field: 'keywords', text: OUT_TEXT.keywords };
  if (isNew && !f.url?.trim()) return { field: 'url', text: OUT_TEXT.workflowsUrl };
  if (!f.destinationLabel.trim()) return { field: 'destination', text: OUT_TEXT.destination };
  if (!EMAIL.test(f.flowOwner.trim())) return { field: 'flowOwner', text: OUT_TEXT.flowOwner };
  return null;
}

export function TeamsOutModal({ rule, config, onClose, onSaved }: { rule: TeamsOutRule | null; config: TeamsConfig; onClose: () => void; onSaved: () => void }) {
  const siteName = useSetting<string>('Site_Name') || 'Wescc Chat';
  const [f, setF] = useState<Form>(() =>
    rule
      ? {
          name: rule.name,
          enabled: rule.enabled,
          roomIds: rule.roomIds,
          filter: rule.filter,
          keywords: rule.keywords,
          includeBots: rule.includeBots,
          includeFiles: rule.includeFiles,
          includeLink: rule.includeLink,
          destinationLabel: rule.destinationLabel,
          destinationPrivate: rule.destinationPrivate,
          flowOwner: rule.flowOwner,
          budget: rule.budget,
          auth: rule.auth,
          url: undefined,
        }
      : empty(),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const formId = useId();
  const ids = { name: useId(), rooms: useId(), keywords: useId(), url: useId(), dest: useId(), owner: useId(), budget: useId() };
  // Erro de um campo: marcado e com o foco nele; o erro do servidor continua no fim (FormError).
  const v = useInvalid<Field>({ name: ids.name, url: ids.url, rooms: ids.rooms, keywords: ids.keywords, destination: ids.dest, flowOwner: ids.owner });
  const set = <K extends keyof Form>(k: K, val: Form[K]) => {
    setF((cur) => ({ ...cur, [k]: val }));
    setError(null);
    const field = FIELD_OF[k];
    if (field) v.clear(field);
  };
  // Autenticar pelo Entra precisa do aplicativo conectado; quem já usa pode desligar.
  const entraReady = config.status.tone === 'ok' || config.status.tone === 'warn';
  const oid = config.appObjectId;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = validate(f, !rule);
    if (problem) {
      setError(null);
      v.show(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { url, ...rest } = f;
      const input: TeamsOutRuleInput & { _id?: string } = {
        ...rest,
        name: f.name.trim(),
        destinationLabel: f.destinationLabel.trim(),
        flowOwner: f.flowOwner.trim(),
        ...(typeof url === 'string' ? { url: url.trim() } : {}),
        ...(rule ? { _id: rule._id } : {}),
      };
      await teamsAdmin.outSave(input);
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
      body: 'As mensagens destas salas deixam de ir para o Teams. O fluxo do Workflows continua existindo no Power Automate.',
      confirmLabel: 'Excluir',
      danger: true,
    });
    if (!yes) return;
    setSaving(true);
    try {
      await teamsAdmin.outRemove(rule._id);
      done('Regra excluída.');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  };

  return (
    <Modal
      size="lg"
      title={rule ? 'Editar regra de envio' : 'Nova regra de envio'}
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
          <input id={ids.name} value={f.name} maxLength={80} placeholder="Ex.: Avisos da operação no Teams" {...v.aria('name')} onChange={(e) => set('name', e.target.value)} />
        </FieldBlock>

        <FieldBlock
          label="Salas do chat"
          hint="As mensagens destas salas vão para o Teams. O robô Microsoft Teams entra nelas para que todos saibam."
          error={v.error('rooms')}
          errorId={v.errorId('rooms')}
        >
          <RoomTargets
            inputId={ids.rooms}
            invalid={v.aria('rooms')}
            provider="msteams"
            mode="read"
            max={10}
            value={f.roomIds}
            onChange={(val) => set('roomIds', val)}
            grantPublisher={false}
            onGrantPublisher={() => {}}
            known={rule?.rooms}
          />
        </FieldBlock>

        <FieldBlock label="Quais mensagens" error={v.error('keywords')} errorId={v.errorId('keywords')}>
          <div className="toggle-list" role="radiogroup" aria-label="Quais mensagens">
            {FILTERS.map((o) => (
              <Radio key={o.id} name={`${formId}-filter`} value={o.id} current={f.filter} onChange={(val) => set('filter', val)}>
                {o.label}
              </Radio>
            ))}
          </div>
          {f.filter === 'keywords' && (
            <ChipInput inputId={ids.keywords} label="Palavras-chave" value={f.keywords} onChange={(val) => set('keywords', val)} max={20} placeholder="Palavras-chave" invalid={v.aria('keywords')} />
          )}
          {f.filter === 'all' && (
            <div className="callout warn">
              <Icon name="warning" />
              <span>Cada mensagem vira um post no Teams. O Workflows aceita cerca de 25 posts a cada 5 minutos por dono do fluxo; acima disso as mensagens vão em resumo.</span>
            </div>
          )}
        </FieldBlock>

        <div className="field">
          <label className="check">
            <input type="checkbox" checked={f.includeBots} aria-describedby={`${formId}-bots`} onChange={(e) => set('includeBots', e.target.checked)} />
            <span>Incluir avisos do Jira e de outros robôs</span>
          </label>
          <span className="field-hint" id={`${formId}-bots`}>
            Mensagens de robôs e webhooks costumam ser muitas.
          </span>
        </div>

        <FieldBlock
          label="Endereço do fluxo (Workflows)"
          htmlFor={ids.url}
          hint="Este endereço funciona como senha: quem o tem publica no canal do Teams."
          error={v.error('url')}
          errorId={v.errorId('url')}
        >
          <SecretField
            id={ids.url}
            label="Endereço do fluxo"
            state={rule?.url ?? { set: false }}
            value={f.url}
            onChange={(val) => set('url', val)}
            placeholder="https://…environment.api.powerplatform.com/…"
            clearable={false}
            invalid={v.aria('url')}
          />
        </FieldBlock>

        <FieldBlock
          label="Destino no Teams"
          htmlFor={ids.dest}
          hint="Só para lembrar para onde vão as mensagens. Aparece no anúncio da sala."
          error={v.error('destination')}
          errorId={v.errorId('destination')}
        >
          <input id={ids.dest} value={f.destinationLabel} maxLength={80} placeholder="Operação › Avisos" {...v.aria('destination')} onChange={(e) => set('destinationLabel', e.target.value)} />
        </FieldBlock>

        <div className="field">
          <label className="check">
            <input type="checkbox" checked={f.destinationPrivate} onChange={(e) => set('destinationPrivate', e.target.checked)} />
            <span>O canal do Teams é privado</span>
          </label>
          {f.destinationPrivate && (
            <div className="callout warn">
              <Icon name="warning" />
              <span>Em canais privados do Teams, o Workflows só publica em nome de uma pessoa (Post as user). Escolha essa opção no fluxo.</span>
            </div>
          )}
        </div>

        <FieldBlock
          label="Dono do fluxo"
          htmlFor={ids.owner}
          hint="A conta que criou o fluxo no Power Automate. As regras do mesmo dono dividem o limite do Workflows."
          error={v.error('flowOwner')}
          errorId={v.errorId('flowOwner')}
        >
          <input
            id={ids.owner}
            type="email"
            spellCheck={false}
            autoComplete="off"
            value={f.flowOwner}
            placeholder="conta.servico@empresa.com"
            {...v.aria('flowOwner')}
            onChange={(e) => set('flowOwner', e.target.value)}
          />
        </FieldBlock>

        <FieldBlock label="Limite de posts" htmlFor={ids.budget} hint="Diminua se o Power Automate pedir para esperar.">
          <select id={ids.budget} value={f.budget} onChange={(e) => set('budget', Number(e.target.value) as Form['budget'])}>
            {BUDGETS.map((n) => (
              <option key={n} value={n}>
                {n} a cada 5 minutos
              </option>
            ))}
          </select>
        </FieldBlock>

        <Toggle checked={f.includeFiles} onChange={(val) => set('includeFiles', val)} label="Incluir nomes dos arquivos" description="Os arquivos não são enviados, só o nome." />
        <Toggle checked={f.includeLink} onChange={(val) => set('includeLink', val)} label={`Incluir o botão “Abrir no ${siteName}”`} description="Precisa do endereço do site configurado." />
        <Toggle
          checked={f.auth === 'entra'}
          disabled={!entraReady && f.auth !== 'entra'}
          onChange={(val) => set('auth', val ? 'entra' : 'none')}
          label="Autenticar com o aplicativo do Entra"
          description="Recomendado: o fluxo só aceita chamadas do aplicativo do chat."
        />
        <Toggle checked={f.enabled} onChange={(val) => set('enabled', val)} label="Regra ativada" />

        <Disclosure label="Como criar o fluxo no Teams" inForm>
          <ol className="int-steps">
            <li>
              <p>Entre no Teams com a conta de serviço que será a dona do fluxo. Abra o canal de destino e, no menu Mais opções do canal, escolha Workflows.</p>
            </li>
            <li>
              <p>Escolha o modelo para postar em um canal quando uma solicitação de webhook for recebida (em inglês: Post to a channel when a webhook request is received).</p>
            </li>
            <li>
              <p>Confira a equipe e o canal, conclua e copie o endereço gerado.</p>
            </li>
            <li>
              {/* Sem o aplicativo, a frase explica o que fazer: não é um código para colar no Power Automate. */}
              <p>
                No Power Automate, abra o fluxo e, no gatilho, em Quem pode disparar o fluxo, escolha Usuários específicos no meu locatário e informe o ID de objeto{' '}
                {oid ? <code>{oid}</code> : OUT_TEXT.noOid}. Na regra, ligue Autenticar com o aplicativo do Entra.
              </p>
            </li>
            <li>
              <p>Em canal privado, no passo de postar, escolha publicar como usuário (Post as user).</p>
            </li>
            <li>
              <p className="muted">(Opção antiga, menos segura: Qualquer pessoa.)</p>
            </li>
          </ol>
        </Disclosure>
        <div className="callout info">
          <Icon name="info" />
          <span>
            No Teams, as mensagens aparecem como enviadas pelo Flow bot (ou pela dona do fluxo). Edições e exclusões feitas no chat não são copiadas. A Microsoft desliga fluxos sem uso por 90 dias; avisamos
            aos 75.
          </span>
        </div>

        {error && <FormError text={error} />}
      </form>
    </Modal>
  );
}
