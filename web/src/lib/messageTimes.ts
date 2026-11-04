// Atalhos de horário ("Lembrar-me" e envio agendado), o texto de uma data e o valor do <input type="datetime-local">.
// Sem store nem React (testado em server/test/web-rules.test.ts). Horários no fuso do aparelho; o servidor guarda o instante.

export interface TimePreset {
  key: string;
  label: string;
  at: Date;
}

const at = (base: Date, days: number, h: number, min = 0) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + days, h, min, 0, 0);
const plusMinutes = (now: Date, m: number) => new Date(now.getTime() + m * 60_000);

// Em 20 minutos · Em 1 hora · Em 3 horas · Amanhã às 9h
export function reminderPresets(now: Date): TimePreset[] {
  return [
    { key: '20m', label: 'Em 20 minutos', at: plusMinutes(now, 20) },
    { key: '1h', label: 'Em 1 hora', at: plusMinutes(now, 60) },
    { key: '3h', label: 'Em 3 horas', at: plusMinutes(now, 180) },
    { key: 'tomorrow', label: 'Amanhã às 9h', at: at(now, 1, 9) },
  ];
}

// Hoje às 18h (só antes das 17h) · Amanhã às 9h · Amanhã às 14h · Segunda-feira às 9h (só se a segunda não for amanhã)
export function schedulePresets(now: Date): TimePreset[] {
  const out: TimePreset[] = [];
  if (now.getHours() < 17) out.push({ key: 'today', label: 'Hoje às 18h', at: at(now, 0, 18) });
  out.push({ key: 'tomorrow9', label: 'Amanhã às 9h', at: at(now, 1, 9) }, { key: 'tomorrow14', label: 'Amanhã às 14h', at: at(now, 1, 14) });
  // A próxima segunda depois de hoje (numa segunda, a da semana seguinte).
  const days = ((8 - now.getDay()) % 7) || 7;
  if (days > 1) out.push({ key: 'monday', label: 'Segunda-feira às 9h', at: at(now, days, 9) });
  return out;
}

const two = (n: number) => String(n).padStart(2, '0');
const hm = (d: Date) => `${two(d.getHours())}:${two(d.getMinutes())}`;
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

// "hoje às 15:20" · "amanhã às 09:00" · "ontem às 18:00" · "qui., 05/11 às 09:00" · "05/11/2027 às 09:00"
export function whenText(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (sameDay(d, now)) return `hoje às ${hm(d)}`;
  if (sameDay(d, at(now, 1, 0))) return `amanhã às ${hm(d)}`;
  if (sameDay(d, at(now, -1, 0))) return `ontem às ${hm(d)}`;
  if (d.getFullYear() !== now.getFullYear()) return `${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()} às ${hm(d)}`;
  const wd = d.toLocaleDateString('pt-BR', { weekday: 'short' });
  return `${wd}, ${two(d.getDate())}/${two(d.getMonth() + 1)} às ${hm(d)}`;
}

// Valor de <input type="datetime-local"> (sem segundos), no fuso do aparelho.
export function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${hm(d)}`;
}

export function fromLocalInput(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}
