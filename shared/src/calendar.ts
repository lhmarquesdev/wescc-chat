// Agenda: eventos e reuniões do chat (com link e convidados). Tudo fica no próprio chat, sem agendas externas.

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
  status: 'confirmed' | 'canceled';
  owner: { _id: string; username: string; name: string };
  attendees: CalendarAttendee[];
  myResponse: AttendeeResponse | 'organizer';
  reminderMinutes: number | null;
  // Reunião do chat: sala própria e link /meet/<código>.
  meeting: { code: string; url: string; rid: string | null; access: MeetingAccess } | null;
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

export interface MeetingInfo {
  event: CalendarEvent;
  canJoin: boolean; // já é convidado/membro ou o link vale para a organização
  joined: boolean; // já é membro da sala da reunião
}

export const RESPONSE_LABEL: Record<AttendeeResponse, string> = {
  pending: 'Sem resposta',
  accepted: 'Vai',
  declined: 'Não vai',
  tentative: 'Talvez',
};

export const REMINDER_CHOICES = [0, 5, 10, 15, 30, 60, 1440];
