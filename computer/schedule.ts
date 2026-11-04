// One entry in schedules.json. With `date` it runs once on that day, without
// it every day, or only on `days` when those are given. `quiet` lets the
// agent stay silent when there's nothing worth telling him, and `paused`
// keeps it from running at all.
export interface Schedule {
	id: string;
	label: string;
	text: string;
	time: string;
	days?: string[];
	date?: string;
	quiet?: boolean;
	paused?: boolean;
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// A computer that slept through the time still runs it if it wakes within this.
export const GRACE = 30 * 60_000;

// The agent writes schedules.json by hand, so bad entries are dropped rather
// than failing the whole list.
export const cleanSchedules = (a: unknown): Schedule[] | null =>
	!Array.isArray(a)
		? null
		: a
				// A date it can't read would otherwise turn a one-off into a daily run.
				.filter(
					(s) =>
						typeof s?.label === "string" &&
						s.label.trim() &&
						typeof s?.text === "string" &&
						s.text.trim() &&
						TIME.test(s?.time) &&
						(s.date === undefined || (typeof s.date === "string" && DATE.test(s.date))),
				)
				.slice(0, 50)
				.map((s) => {
					const out: Schedule = {
						// Read every 20 seconds, so a missing id has to come out the same each time.
						id:
							typeof s.id === "string" && s.id
								? s.id.slice(0, 64)
								: `${s.label.trim()}@${s.time}`.slice(0, 64),
						label: s.label.trim().slice(0, 40),
						text: s.text.trim().slice(0, 2000),
						time: s.time,
					};
					if (Array.isArray(s.days))
						out.days = s.days
							.map((d: unknown) => String(d).slice(0, 3).toLowerCase())
							.filter((d: string) => DAYS.includes(d));
					if (typeof s.date === "string" && DATE.test(s.date)) out.date = s.date;
					if (s.quiet === true) out.quiet = true;
					if (s.paused === true) out.paused = true;
					return out;
				})
				// Days it couldn't read ("weekdays") would otherwise mean every day.
				.filter((s) => !s.days || s.days.length);

const ymd = (d: Date) =>
	`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const keyOf = (item: Schedule, at: Date) => `${item.id}@${ymd(at)}T${item.time}`;

// Every time an entry falls between `from` and `to`, local time.
function times(item: Schedule, from: Date, to: Date): Date[] {
	const out: Date[] = [];
	const [h, m] = item.time.split(":").map(Number);
	for (
		let day = new Date(from.getFullYear(), from.getMonth(), from.getDate());
		day <= to;
		day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
	) {
		if (
			item.date
				? item.date !== ymd(day)
				: item.days?.length && !item.days.includes(DAYS[day.getDay()] ?? "")
		)
			continue;
		const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
		if (at >= from && at <= to) out.push(at);
	}
	return out;
}

// The runs that are due at `now`, keyed so each runs once. `ran` holds the
// keys already run.
export function due(
	items: Schedule[],
	now: Date,
	ran: Set<string>,
): { item: Schedule; key: string }[] {
	// From yesterday, so 23:50 still runs after a wake at 00:10.
	return items
		.filter((i) => !i.paused)
		.flatMap((item) =>
			times(item, new Date(now.getTime() - GRACE + 1), now)
				.map((at) => ({ item, key: keyOf(item, at) }))
				.filter((r) => !ran.has(r.key)),
		);
}

// Runs that fell between `since` and now but are too late to send, because
// the computer was asleep or the server was off. Capped at a day, so a computer that
// was off for a week gets one note per entry rather than seven.
export function missed(
	items: Schedule[],
	since: Date,
	now: Date,
	ran: Set<string>,
): { item: Schedule; key: string; at: Date }[] {
	const from = new Date(Math.max(since.getTime(), now.getTime() - 24 * 3_600_000));
	const until = new Date(now.getTime() - GRACE);
	if (until <= from) return [];
	return items
		.filter((i) => !i.paused)
		.flatMap((item) => {
			const late = times(item, from, until).filter(
				(at) => at > from && !ran.has(keyOf(item, at)),
			);
			const last = late.at(-1);
			return last ? [{ item, key: keyOf(item, last), at: last }] : [];
		});
}

// When an entry runs next, or null if it never will again.
export function next(item: Schedule, now: Date): Date | null {
	if (item.paused) return null;
	return times(item, now, new Date(now.getTime() + 8 * 86_400_000))[0] ?? null;
}
