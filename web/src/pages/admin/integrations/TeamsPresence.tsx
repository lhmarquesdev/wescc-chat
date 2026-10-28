// Integrações (Jira/Teams): Microsoft Teams → Presença (§7.4, fase 3). A presença chega por notificações do Microsoft
// 365 ou, só com o aceite da leitura periódica, por consulta.
import { useEffect, useState } from 'react';
import { plural } from '../../../lib/format';
import { Toggle } from '../../../components/ui';
import { teamsAdmin } from './admin-api';
import { SaveBar, SettingRow, TabBody, done, fail, useDraft, useUnsavedGuard } from './parts';
import type { TeamsTabProps } from './TeamsAdmin';
import './integrations-admin.css';

const MINUTES = [5, 10, 15, 30];

export function TeamsPresence({ config, onConfig, onDirty }: TeamsTabProps) {
  const f = useDraft({ presenceEnabled: config.presenceEnabled, presenceMinutes: config.presenceMinutes });
  const [saving, setSaving] = useState(false);
  const dirty = f.changed.length > 0;
  useUnsavedGuard(dirty);
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  const notifications = !!config.notificationsUrl;
  const polling = !notifications && !!config.pollingAcceptedAt;
  const blocked = !notifications && !polling;

  const save = async () => {
    setSaving(true);
    try {
      const r = await teamsAdmin.save(Object.fromEntries(f.changed.map((k) => [k, f.get(k)])));
      onConfig(r.config);
      f.reset();
      done('Alterações salvas.');
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <TabBody>
        {/* Sem título: logo depois das abas, com o mesmo espaço das outras abas. */}
        <section aria-label="Presença">
          <SettingRow
            label="Presença do Teams"
            modified={f.isChanged('presenceEnabled')}
            help="O cartão da pessoa mostra, por exemplo, “No Teams: Em reunião”. Cada pessoa pode escolher, em Minha conta → Contas conectadas, ficar como Ocupado no chat durante reuniões e chamadas do Teams. As pessoas são encontradas pelo e-mail confirmado. Precisa das permissões Presence.Read.All e User.Read.All."
          >
            <Toggle
              checked={f.get('presenceEnabled')}
              disabled={blocked && !config.presenceEnabled}
              onChange={(v) => f.set('presenceEnabled', v)}
              label="Mostrar a presença do Teams no chat"
            />
            {blocked && <span className="small muted">Precisa das notificações do Microsoft 365 ou do aceite da leitura periódica (aba Mensagens do Teams).</span>}
            {notifications && <span className="small muted">A presença chega por notificações do Microsoft 365.</span>}
          </SettingRow>
          {polling && (
            <SettingRow label="Ler a presença a cada" htmlFor="teams-presence-minutes" modified={f.isChanged('presenceMinutes')}>
              <select id="teams-presence-minutes" value={f.get('presenceMinutes')} onChange={(e) => f.set('presenceMinutes', Number(e.target.value))}>
                {MINUTES.map((n) => (
                  <option key={n} value={n}>
                    {plural(n, 'minuto', 'minutos')}
                  </option>
                ))}
              </select>
            </SettingRow>
          )}
        </section>
      </TabBody>
      <SaveBar count={f.changed.length} saving={saving} onDiscard={f.reset} onSave={() => void save()} />
    </>
  );
}
