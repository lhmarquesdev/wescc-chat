import { describe, expect, it, vi } from 'vitest';
import type { CalendarEvent } from '@shared/calendar';

// Regras puras da Agenda no navegador (web/src/lib/calendar.ts). O cliente HTTP e o tempo real não são usados aqui.
vi.mock('../../web/src/lib/api', () => ({ api: {} }));
vi.mock('../../web/src/lib/realtime', () => ({ realtime: { on: () => () => {} } }));
const { fromInputs, layoutDay, whenLabel } = await import('../../web/src/lib/calendar');

let n = 0;
// Hora local (a grade da semana usa o dia do calendário de quem lê).
const at = (day: number, h: number, min = 0) => new Date(2026, 11, day, h, min).toISOString();
function ev(startsAt: string, endsAt: string, over: Partial<CalendarEvent> = {}): CalendarEvent {
  n++;
  return {
    _id: `e${n}`,
    title: `Evento ${n}`,
    description: '',
    location: '',
    startsAt,
    endsAt,
    allDay: false,
    status: 'confirmed',
    owner: { _id: 'u1', username: 'ana', name: 'Ana' },
    attendees: [],
    myResponse: 'organizer',
    reminderMinutes: 10,
    meeting: null,
    canEdit: true,
    updatedAt: startsAt,
    ...over,
  };
}

describe('semana: eventos de cada dia', () => {
  it('evento de um dia anterior ou que termina às 00:00 não vira bloco fantasma às 00:00', () => {
    const monday = ev(at(7, 9), at(7, 10));
    const overnight = ev(at(8, 23), at(9, 1));
    const toMidnight = ev(at(10, 22), at(11, 0));
    const all = [monday, overnight, toMidnight];
    expect(layoutDay(all, new Date(2026, 11, 7)).map((p) => p.e._id)).toEqual([monday._id]);
    // Quarta: só a continuação das 00:00 às 01:00, na largura toda.
    const wed = layoutDay(all, new Date(2026, 11, 9));
    expect(wed.map((p) => [p.e._id, p.top, p.height, p.cols])).toEqual([[overnight._id, 0, 60, 1]]);
    // Quinta: o que termina exatamente à meia-noite fica só na quinta.
    expect(layoutDay(all, new Date(2026, 11, 10)).map((p) => p.e._id)).toEqual([toMidnight._id]);
    for (const d of [11, 12, 13]) expect(layoutDay(all, new Date(2026, 11, d))).toEqual([]);
  });

  it('eventos que se sobrepõem ficam lado a lado e os curtos ganham altura mínima', () => {
    const a = ev(at(14, 10), at(14, 11));
    const b = ev(at(14, 10, 30), at(14, 12));
    const short = ev(at(14, 15), at(14, 15, 5));
    const out = layoutDay([a, b, short], new Date(2026, 11, 14));
    expect(out.map((p) => [p.e._id, p.col, p.cols])).toEqual([
      [a._id, 0, 2],
      [b._id, 1, 2],
      [short._id, 0, 1],
    ]);
    expect(out[2].height).toBe(15);
    expect(layoutDay([ev(at(14, 0), at(15, 0), { allDay: true })], new Date(2026, 11, 14))).toEqual([]);
  });
});

describe('editor: datas digitadas', () => {
  it('data apagada ou incompleta vira data inválida (e não 01/01/1900)', () => {
    expect(Number.isNaN(fromInputs('', '10:00').getTime())).toBe(true);
    expect(Number.isNaN(fromInputs('2026-12', '10:00').getTime())).toBe(true);
    expect(fromInputs('2026-12-10', '14:30').getTime()).toBe(new Date(2026, 11, 10, 14, 30).getTime());
    expect(fromInputs('2026-12-10', '').getTime()).toBe(new Date(2026, 11, 10).getTime());
  });

  it('o horário mostra o ano quando o evento não é deste ano', () => {
    const y = new Date().getFullYear();
    const other = { allDay: false, startsAt: new Date(y + 2, 0, 4, 10).toISOString(), endsAt: new Date(y + 2, 0, 4, 11).toISOString() };
    expect(whenLabel(other)).toContain(String(y + 2));
    const old = { allDay: false, startsAt: new Date(1900, 0, 1, 10, 30).toISOString(), endsAt: new Date(1900, 0, 1, 11, 30).toISOString() };
    expect(whenLabel(old)).toContain('1900');
    // Deste ano: sem o ano (três dias para trás ou para a frente, sem virar o ano).
    const t = new Date();
    const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() + (t.getMonth() === 11 ? -3 : 3), 10);
    expect(whenLabel({ allDay: false, startsAt: d.toISOString(), endsAt: new Date(d.getTime() + 3_600_000).toISOString() })).not.toContain(String(y));
  });
});
