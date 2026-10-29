// Pílula "Teams" das mensagens copiadas do Microsoft Teams (no lugar da pílula "Bot" das mensagens com alias).
import { Icon } from '../Icon';
import { useIsPhone } from '../overlay';
import { Tooltip } from '../ui';
import './integrations.css';

export function BridgeBadge() {
  return (
    <Tooltip label="Mensagem copiada do Microsoft Teams">
      <span className="pill bridge-pill">
        <Icon name="bridge-teams" size={12} />
        Teams
      </span>
    </Tooltip>
  );
}

// @ do robô ao lado do nome, como nas outras mensagens de integração; no celular fica de fora: a pílula "Teams" já diz
// de onde veio e o nome da pessoa precisa do espaço.
export function BridgeUsername({ username }: { username: string }) {
  const phone = useIsPhone();
  return phone ? null : <span className="msg-username">@{username}</span>;
}
