// Avisos das mensagens em qualquer tela: lembrete que chegou ("Lembrar-me") e envio agendado que falhou.
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Message } from '@shared/index';
import { messagePreviewText } from '@shared/stickers';
import { roomPath } from '../lib/format';
import { authorName, messageLink } from '../lib/messageRules';
import { realtime } from '../lib/realtime';
import { systemNotify } from '../lib/session';
import { useStore } from '../lib/store';

// Prévia de uma mensagem numa linha (cifrada: "Mensagem criptografada").
export const messagePreview = (m: Message) =>
  messagePreviewText({ msg: m.msg, sticker: m.sticker, files: m.files, forward: m.forward, poll: m.poll, e2e: (m as { e2e?: unknown }).e2e }, { withName: false });

// Texto do lembrete: "Ana: prévia" (até 120 caracteres); sem a mensagem (sem acesso), só o aviso.
export function reminderText(m: Message | null) {
  if (!m) return 'Você pediu para ser lembrado de uma mensagem.';
  const text = `${authorName(m)}: ${messagePreview(m)}`;
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

export function MessageNotices() {
  const navigate = useNavigate();
  useEffect(() => {
    const off = realtime.on((ev) => {
      const st = useStore.getState();
      if (ev.type === 'message.reminder' && ev.action === 'fired') {
        const r = ev.reminder;
        const text = reminderText(r.message);
        const path = messageLink({ rid: r.rid, t: r.t, mid: r.messageId, tmid: r.message?.tmid });
        st.toast(`Lembrete: ${text}`, 'info', { icon: 'remind', duration: 30_000, action: { label: 'Ver mensagem', onClick: () => navigate(path) } });
        systemNotify('Lembrete', text, `reminder-${r._id}`, path);
      } else if (ev.type === 'message.scheduled' && ev.action === 'upserted' && ev.notify && ev.scheduled.status === 'failed') {
        const s = ev.scheduled;
        const sub = st.subscriptions[s.rid];
        const where = sub ? (sub.t === 'd' ? sub.fname || sub.name : `#${sub.fname || sub.name}`) : 'uma conversa';
        const path = `${roomPath({ rid: s.rid, t: sub?.t ?? 'c' })}?tab=scheduled`;
        st.toast(`Sua mensagem agendada em ${where} não foi enviada: ${s.error ?? ''}`, 'error', { icon: 'schedule', duration: 15_000, action: { label: 'Ver', onClick: () => navigate(path) } });
      }
    });
    return () => void off();
  }, [navigate]);
  return null;
}
