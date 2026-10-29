// "Nova versão do chat disponível.": aparece quando /build.json traz outro id. Durante uma chamada espera ela acabar.
import { useEffect, useState } from 'react';
import { startBuildCheck, useBuild } from '../../lib/call/build';
import { useCallStore } from '../../lib/call/store';
import { Icon } from '../Icon';

export function VersionPrompt() {
  const newer = useBuild((s) => s.newer);
  const busy = useCallStore((s) => s.phase !== 'idle' || !!s.preflight || s.incoming.length > 0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => startBuildCheck(), []);
  if (!newer || busy || dismissed === newer) return null;
  return (
    <div className="call-version" role="status">
      <Icon name="info" size={18} className="call-version-icon" />
      <span className="call-version-text">Nova versão do chat disponível.</span>
      <button type="button" className="call-version-action" onClick={() => location.reload()}>
        Recarregar
      </button>
      <button type="button" className="icon-btn call-version-close" aria-label="Fechar aviso" title="Fechar aviso" onClick={() => setDismissed(newer)}>
        <Icon name="close" />
      </button>
    </div>
  );
}
