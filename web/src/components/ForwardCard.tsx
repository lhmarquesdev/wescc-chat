import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { MessageForward } from '@shared/messages';
import { formatDateTime, formatWhen } from '../lib/format';
import { forwardOrigin } from '../lib/messageRules';
import { useStore } from '../lib/store';
import { Icon } from './Icon';

// Cartão da mensagem encaminhada: de onde veio (com link só quando quem vê tem como abrir), quem escreveu e quando.
// O conteúdo (texto sem menções ativas, figurinha, anexos) vem de MessageView.
export function ForwardCard({ f, children }: { f: MessageForward; children: ReactNode }) {
  const navigate = useNavigate();
  const subs = useStore((s) => s.subscriptions);
  const origin = forwardOrigin(f, subs);
  const author = f.alias || f.u.name || f.u.username;
  return (
    <div className="fwd-card">
      <div className="fwd-head">
        <span className="fwd-from">
          <Icon name="forward" size={14} />
          {origin.link ? (
            <a
              className="fwd-origin"
              href={origin.link}
              title={origin.text}
              onClick={(e) => {
                e.preventDefault();
                navigate(origin.link!);
              }}
            >
              {origin.text}
            </a>
          ) : (
            <span className="fwd-origin" title={origin.text}>
              {origin.text}
            </span>
          )}
        </span>
        {/* Autor e hora não se separam: na tela estreita o par desce inteiro, sem deixar um "·" sozinho na linha. */}
        <span className="fwd-meta">
          <span className="fwd-author" title={author}>
            {author}
          </span>
          <span aria-hidden="true">·</span>
          <time dateTime={f.ts} title={formatDateTime(f.ts)}>
            {formatWhen(f.ts)}
          </time>
        </span>
      </div>
      {children}
    </div>
  );
}
