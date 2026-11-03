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
        <Icon name="forward" size={14} />
        {origin.link ? (
          <a
            href={origin.link}
            onClick={(e) => {
              e.preventDefault();
              navigate(origin.link!);
            }}
          >
            {origin.text}
          </a>
        ) : (
          <span>{origin.text}</span>
        )}
        <span aria-hidden="true">·</span>
        <span className="fwd-author">{author}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={f.ts} title={formatDateTime(f.ts)}>
          {formatWhen(f.ts)}
        </time>
      </div>
      {children}
    </div>
  );
}
