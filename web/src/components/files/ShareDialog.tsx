// Arquivos: compartilhamento de uma pasta (papéis, canais/grupos e pessoas, cada um com Pode ver / Pode editar / Gerencia).
import { useEffect, useMemo, useRef, useState } from 'react';
import { DRIVE_LEVELS, type DriveAclEntry, type DriveFolder, type DriveSubject } from '@shared/drive';
import { errorMessage } from '../../lib/api';
import { filesApi } from '../../lib/files';
import { useStore } from '../../lib/store';
import { Icon } from '../Icon';
import type { IconName } from '../icons';
import { Avatar, Modal, Spinner, Toggle } from '../ui';

const TYPE_ICON: Record<string, IconName> = { role: 'files-manage', room: 'files-room', user: 'files-user' };
const TYPE_LABEL: Record<string, string> = { role: 'Papel', room: 'Canal ou grupo', user: 'Pessoa' };

type Entry = Pick<DriveAclEntry, 'type' | 'id' | 'level' | 'label' | 'sublabel' | 'missing'>;

export function SubjectIcon({ e }: { e: { type: string; sublabel?: string } }) {
  if (e.type === 'user' && e.sublabel?.startsWith('@')) return <Avatar username={e.sublabel.slice(1)} size={32} />;
  return (
    <span className={`fl-subject-icon ${e.type}`} aria-hidden="true">
      <Icon name={TYPE_ICON[e.type]} size={16} />
    </span>
  );
}

function LevelSelect({ value, onChange, label }: { value: number; onChange: (l: 1 | 2 | 3) => void; label: string }) {
  return (
    <select className="fl-level-select" aria-label={label} value={value} onChange={(e) => onChange(Number(e.target.value) as 1 | 2 | 3)}>
      {DRIVE_LEVELS.map((l) => (
        <option key={l.level} value={l.level}>
          {l.label}
        </option>
      ))}
    </select>
  );
}

export function ShareDialog({ folder, acl, onClose, onSaved }: { folder: DriveFolder; acl: DriveAclEntry[]; onClose: () => void; onSaved: (acl: DriveAclEntry[]) => void }) {
  const me = useStore((s) => s.me)!;
  const toast = useStore((s) => s.toast);
  const [entries, setEntries] = useState<Entry[]>(() => acl.filter((e) => !e.from));
  const inherited = acl.filter((e) => e.from);
  const [inherit, setInherit] = useState(folder.inherit);
  const [text, setText] = useState('');
  const [results, setResults] = useState<DriveSubject[] | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const isSub = !!folder.parentId;

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      filesApi
        .subjects(text)
        .then((r) => alive && setResults(r))
        .catch(() => alive && setResults([]));
    }, 180);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [text]);

  const has = useMemo(() => new Set(entries.map((e) => `${e.type}:${e.id}`)), [entries]);
  const add = (s: DriveSubject) => {
    if (has.has(`${s.type}:${s.id}`)) return;
    setEntries((list) => [...list, { ...s, level: s.type === 'user' ? 2 : 1 }]);
    setText('');
    setListOpen(false);
    inputRef.current?.focus();
  };
  const set = (i: number, level: 1 | 2 | 3) => setEntries((l) => l.map((e, j) => (j === i ? { ...e, level } : e)));
  const remove = (i: number) => setEntries((l) => l.filter((_, j) => j !== i));
  const removesMe = !entries.some((e) => e.type === 'user' && e.id === me._id && e.level === 3);

  const save = async () => {
    setSaving(true);
    try {
      const out = await filesApi.share(
        folder._id,
        entries.map((e) => ({ type: e.type, id: e.id, level: e.level })),
        inherit,
      );
      toast('Compartilhamento salvo.', 'success');
      onSaved(out);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  const suggestions = (results ?? []).filter((s) => !has.has(`${s.type}:${s.id}`));

  return (
    <Modal
      wide
      title={`Compartilhar “${folder.name}”`}
      description="Dê acesso a um papel, aos membros de um canal ou grupo (a operação) ou a pessoas. Subpastas recebem o mesmo acesso."
      onClose={onClose}
      className="fl-share"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn primary" disabled={saving} onClick={save}>
            {saving && <Spinner size="sm" />}
            Salvar
          </button>
        </>
      }
    >
      <div className="fl-share-search">
        <Icon name="search" size={16} />
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => (setText(e.target.value), setListOpen(true))}
          onClick={() => setListOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setListOpen(true);
            if (e.key === 'Escape' && listOpen) {
              e.stopPropagation();
              setListOpen(false);
            }
            if (e.key === 'Enter' && suggestions[0]) {
              e.preventDefault();
              add(suggestions[0]);
            }
          }}
          placeholder="Adicionar papel, canal, grupo ou pessoa"
          aria-label="Buscar papel, canal, grupo ou pessoa"
          autoComplete="off"
        />
      </div>
      {listOpen && suggestions.length > 0 && (
        <ul className="fl-suggest" aria-label="Sugestões">
          {suggestions.slice(0, 8).map((s) => (
            <li key={`${s.type}:${s.id}`}>
              <button type="button" onClick={() => add(s)}>
                <SubjectIcon e={s} />
                <span className="fl-subject-text">
                  <strong className="ellipsis">{s.label}</strong>
                  <small className="muted ellipsis">{s.sublabel ?? TYPE_LABEL[s.type]}</small>
                </span>
                <span className="fl-suggest-add">
                  <Icon name="add" size={16} />
                  Adicionar
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3 className="fl-share-h">Quem tem acesso</h3>
      {entries.length === 0 && <p className="muted fl-share-none">Ninguém além de quem gerencia todas as pastas.</p>}
      <ul className="fl-acl">
        {entries.map((e, i) => (
          <li key={`${e.type}:${e.id}`} className={e.missing ? 'missing' : undefined}>
            <SubjectIcon e={e} />
            <span className="fl-subject-text">
              <strong className="ellipsis">
                {e.label}
                {e.type === 'user' && e.id === me._id && <span className="muted"> (você)</span>}
              </strong>
              <small className="muted ellipsis">{e.missing ? 'Não existe mais' : (e.sublabel ?? TYPE_LABEL[e.type])}</small>
            </span>
            <LevelSelect value={e.level} label={`Nível de ${e.label}`} onChange={(l) => set(i, l)} />
            <button type="button" className="icon-btn" aria-label={`Tirar ${e.label}`} title="Tirar o acesso" onClick={() => remove(i)}>
              <Icon name="close" size={16} />
            </button>
          </li>
        ))}
      </ul>
      {removesMe && entries.length > 0 && (
        <p className="fl-share-warn">
          <Icon name="warning" size={16} />
          Você não está como “Gerencia”: depois de salvar, talvez não consiga mais mudar este compartilhamento.
        </p>
      )}

      {isSub && (
        <div className="fl-inherit">
          <Toggle
            checked={inherit}
            onChange={setInherit}
            label="Herdar o acesso da pasta de cima"
            description={inherit ? 'Quem acessa a pasta de cima também acessa esta.' : 'Só quem está na lista acima acessa esta pasta (pasta restrita).'}
          />
        </div>
      )}
      {isSub && inherit && inherited.length > 0 && (
        <>
          <h3 className="fl-share-h">Herdado das pastas de cima</h3>
          <ul className="fl-acl inherited">
            {inherited.map((e) => (
              <li key={`${e.from!._id}:${e.type}:${e.id}`}>
                <SubjectIcon e={e} />
                <span className="fl-subject-text">
                  <strong className="ellipsis">{e.label}</strong>
                  <small className="muted ellipsis">
                    {e.sublabel ?? TYPE_LABEL[e.type]} · de “{e.from!.name}”
                  </small>
                </span>
                <span className="pill small">{DRIVE_LEVELS.find((l) => l.level === e.level)?.label}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <dl className="fl-levels-help">
        {DRIVE_LEVELS.map((l) => (
          <div key={l.level}>
            <dt>{l.label}</dt>
            <dd>{l.description}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}
