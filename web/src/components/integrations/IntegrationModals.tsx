// Os modais das integrações pedidos pelas respostas efêmeras, pelo menu da mensagem e pelo cabeçalho da sala.
// Montado uma vez pela sala; cada modal só carrega quando é aberto.
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { LinkedAccount } from '@shared/integrations';
import { settleEphemeralRequest } from '../../lib/ephemeral';
import { loadIntegrationsMe, useIntegrationModal, useIntegrationsMe, type IntegrationModalRequest } from '../../lib/integrations';

const JiraIssueModal = lazy(() => import('./JiraIssueModal'));
const JiraCommentModal = lazy(() => import('./JiraCommentModal'));
const JiraAssignModal = lazy(() => import('./JiraAssignModal'));
const MeetingModal = lazy(() => import('./MeetingModal'));
const JiraTokenModal = lazy(() => import('../../pages/account/JiraTokenModal').then((m) => ({ default: m.JiraTokenModal })));

export function IntegrationModals({ rid }: { rid: string }) {
  const [req, close] = useIntegrationModal();
  // Pedido de outra sala (ou que ficou para trás ao trocar de sala) não abre aqui.
  useEffect(() => () => close(), [rid, close]);
  if (!req || req.rid !== rid) return null;
  return (
    <Suspense fallback={null}>
      <Requested key={`${req.modal}:${req.messageId ?? ''}:${req.params?.key ?? ''}`} req={req} onClose={close} />
    </Suspense>
  );
}

function Requested({ req, onClose }: { req: IntegrationModalRequest; onClose: () => void }) {
  const me = useIntegrationsMe();
  // Comentar e atribuir agem pela conta da pessoa: sem conta vinculada, primeiro o passo de conectar.
  const needsLink = (req.modal === 'jira-comment' || req.modal === 'jira-assign') && !!me && me.jira.userAuth !== 'off' && !me.jira.account;
  const [linked, setLinked] = useState(false);
  // JiraTokenModal chama onLinked e depois onClose: depois de conectar, o onClose não fecha o modal pedido.
  const justLinked = useRef(false);
  const onLinked = (_a: LinkedAccount) => {
    void loadIntegrationsMe(true);
    // "Conectar conta" pedido por uma resposta: conectada, a resposta sai.
    if (req.modal === 'jira-link') return settleEphemeralRequest(req);
    justLinked.current = true;
    setLinked(true);
  };
  const closeLink = () => {
    if (justLinked.current) justLinked.current = false;
    else onClose();
  };
  if (req.modal === 'jira-link' || (needsLink && !linked)) return <JiraTokenModal onClose={closeLink} onLinked={onLinked} />;
  switch (req.modal) {
    case 'jira-create':
      return <JiraIssueModal req={req} onClose={onClose} />;
    case 'jira-comment':
      return <JiraCommentModal req={req} onClose={onClose} />;
    case 'jira-assign':
      return <JiraAssignModal req={req} onClose={onClose} />;
    case 'msteams-meeting':
      return <MeetingModal req={req} onClose={onClose} />;
    default:
      return null;
  }
}
