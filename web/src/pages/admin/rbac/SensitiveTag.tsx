// Marca de permissão sensível: dá poder sobre outras pessoas, sobre dados ou sobre o próprio RBAC. A completa diz
// "Sensível" com o risco na dica; a compacta (lista de papéis) mostra só o ícone e quantas são.
import { RBAC_KEYS, rbacLabel } from '@shared/rbac';
import { nameList } from '../../../lib/format';
import { Icon } from '../../../components/Icon';
import { Tooltip } from '../../../components/ui';

// label: mostra o nome da permissão no lugar de "Sensível" (O que este papel libera).
export function SensitiveTag({ k, label }: { k: string; label?: boolean }) {
  const risk = RBAC_KEYS[k]?.sensitive;
  if (!risk) return null;
  const text = label ? rbacLabel(k) : 'Sensível';
  return (
    <Tooltip label={risk}>
      <span className="pill warn tag rbac-tag-sensitive" aria-label={`${text}: ${risk}`}>
        <Icon name="rbac-sensitive" size={12} />
        {text}
      </span>
    </Tooltip>
  );
}

// Quantas sensíveis um papel tem, com os nomes na dica.
export function SensitiveCount({ keys }: { keys: string[] }) {
  const list = keys.filter((k) => RBAC_KEYS[k]?.sensitive);
  if (!list.length) return null;
  const text = `${list.length} ${list.length === 1 ? 'permissão sensível' : 'permissões sensíveis'}: ${nameList(list.map(rbacLabel), 6)}`;
  return (
    <Tooltip label={text}>
      <span className="rbac-tag-sensitive compact" aria-label={text}>
        <Icon name="rbac-sensitive" size={14} />
        {list.length}
      </span>
    </Tooltip>
  );
}
