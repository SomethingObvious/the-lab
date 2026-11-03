// One entry in schedules.json. With `date` it runs once on that day, without
// it every day, or only on `days` when those are given.
export type Schedule = { id: string; label: string; text: string; time: string; days?: string[]; date?: string };

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// A Mac that slept through the time still runs it if it wakes within this.
const GRACE = 30 * 60_000;

// The agent writes schedules.json by hand, so bad entries are dropped rather
// than failing the whole list.
export const cleanSchedules = (a: unknown): Schedule[] | null => !Array.isArray(a) ? null : a
  // A date it can't read would otherwise turn a one-off into a daily run.
  .filter((s) => typeof s?.label === 'string' && s.label.trim() && typeof s?.text === 'string' && s.text.trim() && TIME.test(s?.time)
    && (s.date === undefined || (typeof s.date === 'string' && DATE.test(s.date))))
  .slice(0, 50)
  .map((s) => ({
    // Read every 20 seconds, so a missing id has to come out the same each time.
    id: typeof s.id === 'string' && s.id ? s.id.slice(0, 64) : `${s.label.trim()}@${s.time}`.slice(0, 64),
    label: s.label.trim().slice(0, 40),
    text: s.text.trim().slice(0, 2000),
    time: s.time,
    ...(Array.isArray(s.days) ? { days: s.days.map((d: unknown) => String(d).slice(0, 3).toLowerCase()).filter((d: string) => DAYS.includes(d)) } : {}),
    ...(typeof s.date === 'string' && DATE.test(s.date) ? { date: s.date } : {}),
  }))
  // Days it couldn't read ("weekdays") would otherwise mean every day.
  .filter((s) => !s.days || s.days.length);

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// The runs that are due at `now` (local time), keyed so each runs once.
// `ran` holds the keys already run.
export function due(items: Schedule[], now: Date, ran: Set<string>): { item: Schedule; key: string }[] {
  const out: { item: Schedule; key: string }[] = [];
  // Yesterday too, so 23:50 still runs after a wake at 00:10.
  for (const back of [1, 0]) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    for (const item of items) {
      if (item.date ? item.date !== ymd(day) : item.days?.length && !item.days.includes(DAYS[day.getDay()])) continue;
      const [h, m] = item.time.split(':').map(Number);
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
      const key = `${item.id}@${ymd(day)}T${item.time}`;
      if (now >= at && now.getTime() - at.getTime() < GRACE && !ran.has(key)) out.push({ item, key });
    }
  }
  return out;
}
