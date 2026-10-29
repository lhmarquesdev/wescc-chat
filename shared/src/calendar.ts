// Agenda: eventos, reuniões do chat (com link e convidados) e a sincronização com o Google Agenda e o Outlook/Teams.

export type CalendarSource = 'chat' | 'google' | 'microsoft';
export type CalendarProvider = 'google' | 'microsoft';
// import: só traz do Google/Outlook para o chat · export: só leva do chat para lá · both: os dois sentidos.
export type SyncDirection = 'import' | 'export' | 'both';
export type AttendeeResponse = 'pending' | 'accepted' | 'declined' | 'tentative';
// invited: só convidados entram pelo link · org: qualquer pessoa com conta no chat que tiver o link.
export type MeetingAccess = 'invited' | 'org';

export interface CalendarAttendee {
  _id: string;
  username: string;
  name: string;
  response: AttendeeResponse;
}

export interface CalendarEvent {
  _id: string;
  title: string;
  description: string;
  location: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  source: CalendarSource;
  status: 'confirmed' | 'canceled';
  owner: { _id: string; username: string; name: string };
  attendees: CalendarAttendee[];
  myResponse: AttendeeResponse | 'organizer';
  reminderMinutes: number | null;
  // Reunião do chat: sala própria e link /meet/<código>.
  meeting: { code: string; url: string; rid: string | null; access: MeetingAccess } | null;
  // Eventos trazidos do Google/Outlook (só leitura no chat).
  externalUrl: string | null;
  externalJoinUrl: string | null;
  canEdit: boolean;
  updatedAt: string;
}

export interface CalendarEventInput {
  title: string;
  description?: string;
  location?: string;
  startsAt: string;
  endsAt: string;
  allDay?: boolean;
  attendeeIds?: string[];
  isMeeting?: boolean;
  meetingAccess?: MeetingAccess;
  reminderMinutes?: number | null;
}

export interface CalendarAccount {
  provider: CalendarProvider;
  email: string;
  displayName: string;
  direction: SyncDirection;
  status: 'ok' | 'expired' | 'error';
  statusText: string | null;
  lastSyncAt: string | null;
  connectedAt: string;
}

export interface CalendarProviderInfo {
  provider: CalendarProvider;
  available: boolean; // o administrador configurou
  account: CalendarAccount | null;
}

export interface MeetingInfo {
  event: CalendarEvent;
  canJoin: boolean; // já é convidado/membro ou o link vale para a organização
  joined: boolean; // já é membro da sala da reunião
}

export interface CalendarAdminConfig {
  google: { enabled: boolean; clientId: string; secretSet: boolean; redirectUri: string };
  microsoft: { enabled: boolean; usesTeamsApp: boolean; tenantId: string; clientId: string; secretSet: boolean; redirectUri: string };
  syncMinutes: number;
}

export const DIRECTION_LABEL: Record<SyncDirection, string> = {
  both: 'Nos dois sentidos',
  import: 'Só trazer para o chat',
  export: 'Só levar do chat',
};

export const PROVIDER_LABEL: Record<CalendarProvider, string> = { google: 'Google Agenda', microsoft: 'Outlook / Teams' };

export const RESPONSE_LABEL: Record<AttendeeResponse, string> = {
  pending: 'Sem resposta',
  accepted: 'Vai',
  declined: 'Não vai',
  tentative: 'Talvez',
};

export const REMINDER_CHOICES = [0, 5, 10, 15, 30, 60, 1440];
