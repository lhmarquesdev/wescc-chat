// Arquivos: envios em andamento (ou que deram erro) no item Arquivos do menu, para quem saiu da tela Arquivos. Na tela
// Arquivos, a fila de envios mostra os detalhes.
import { useUploads } from '../../lib/files';
import { badgeCount, plural } from '../../lib/format';

export function UploadsNavBadge() {
  const jobs = useUploads();
  const active = jobs.filter((j) => j.state === 'waiting' || j.state === 'sending').length;
  const failed = jobs.filter((j) => j.state === 'error').length;
  if (active) {
    const label = `Enviando ${plural(active, 'arquivo', 'arquivos')}`;
    return (
      <span className="badge" role="img" aria-label={label} title={label}>
        {badgeCount(active)}
      </span>
    );
  }
  if (!failed) return null;
  const label = failed === 1 ? 'Um envio deu erro' : `${failed} envios deram erro`;
  return (
    <span className="badge mention" role="img" aria-label={label} title={label}>
      !
    </span>
  );
}
