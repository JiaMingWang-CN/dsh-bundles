/**
 * Scheduled tasks: explicit-time parsing, durable entries, and due/missed
 * decisions.
 *
 * The plan fixes three things this module must not blur:
 *
 * - Time is always explicit. `+30m`, `HH:MM`, `YYYY-MM-DD HH:MM`, `daily HH:MM`
 *   and `every 30m` are accepted; anything vaguer is refused, because silently
 *   guessing what "tomorrow morning" means is how a scheduled command runs at
 *   the wrong hour.
 * - Every listing shows the timezone and the next trigger, both stored on the
 *   entry itself rather than re-derived on read.
 * - A trigger missed while DSH was down is *recorded as missed*, never run late:
 *   a high-privilege task that was supposed to run at 03:00 must not fire at
 *   09:00 because the laptop was asleep, and the occurrence counter still
 *   advances so the same slot is never retried.
 */

/** How late a trigger may still be considered on time. */
const GRACE_MS = 60_000;

/** Identity prefix for trigger occurrences, so each firing is attributable. */
const OCCURRENCE_SEPARATOR = '#';

/** Offsets accepted in a `+<n><unit>` relative time. */
const RELATIVE_UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Fixed intervals accepted in `every <n><unit>`. */
const INTERVAL_UNITS = { m: 60_000, h: 3_600_000 };

/** Local wall-clock pattern `YYYY-MM-DD HH:MM` (also accepts `T` and seconds). */
const ABSOLUTE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Local wall-clock pattern `HH:MM`. */
const CLOCK_PATTERN = /^(\d{2}):(\d{2})$/;

/** Relative pattern `+<n><unit>`. */
const RELATIVE_PATTERN = /^\+(\d+)([smhd])$/;

/** Interval pattern `every <n><unit>`. */
const INTERVAL_PATTERN = /^(\d+)([mh])$/;

/** How this scheduler states its times. */
const TIME_FORMAT_NOTE = '所有时间均为 DSH 所在机器的本地时间；不接受"明天早上"这类模糊表述。';

/**
 * The timezone label stored with every entry, so a listing never has to guess.
 * @param now - current epoch milliseconds.
 * @param timeZone - IANA zone name, or undefined for the host's zone.
 * @returns a label such as `Asia/Shanghai (UTC+8)`.
 */
function timeZoneLabel(now = Date.now(), timeZone) {
	try {
		const formatter = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' });
		const name = formatter.formatToParts(new Date(now)).find((part) => part.type === 'timeZoneName')?.value ?? '';
		const zone = timeZone ?? formatter.resolvedOptions().timeZone;
		const offset = name.replace('GMT', 'UTC');
		return offset === '' || offset === 'UTC' ? zone : `${zone} (${offset})`;
	} catch {
		return timeZone ?? '本地时区';
	}
}

/** Format one epoch millisecond as a local wall-clock string. */
function formatLocal(at) {
	const date = new Date(at);
	const pad = (value) => String(value).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Build one local wall-clock time, rejecting impossible calendar values. */
function localTime(year, month, day, hour, minute, second = 0) {
	if (hour > 23 || minute > 59 || second > 59) return undefined;
	const date = new Date(year, month - 1, day, hour, minute, second, 0);
	if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return undefined;
	return date.getTime();
}

/**
 * Parse one explicit time expression.
 * @param tokens - the time tokens from the command (one or two tokens).
 * @param now - current epoch milliseconds.
 * @returns `{ ok: true, kind, at?, everyMs?, label }` or `{ ok: false, reason }`.
 */
function parseWhen(tokens, now = Date.now()) {
	const parts = (Array.isArray(tokens) ? tokens : []).filter((token) => typeof token === 'string' && token !== '');
	if (parts.length === 0) return { ok: false, reason: 'when-missing' };
	const [first, second] = parts;
	const relative = RELATIVE_PATTERN.exec(first);
	if (relative !== null && parts.length === 1) {
		const amount = Number(relative[1]);
		const unit = RELATIVE_UNITS[relative[2]];
		if (amount <= 0) return { ok: false, reason: 'when-not-future' };
		const at = now + amount * unit;
		return { ok: true, kind: 'once', at, label: `一次性 · ${formatLocal(at)}` };
	}
	const interval = INTERVAL_PATTERN.exec(second ?? '');
	if (first === 'every' && interval !== null && parts.length === 2) {
		const amount = Number(interval[1]);
		const everyMs = amount * INTERVAL_UNITS[interval[2]];
		if (amount <= 0) return { ok: false, reason: 'when-not-future' };
		const at = now + everyMs;
		return { ok: true, kind: 'every', everyMs, at, label: `每 ${amount}${interval[2] === 'm' ? '分钟' : '小时'} · 下次 ${formatLocal(at)}` };
	}
	const daily = CLOCK_PATTERN.exec(second ?? '');
	if (first === 'daily' && daily !== null && parts.length === 2) {
		const hour = Number(daily[1]);
		const minute = Number(daily[2]);
		const base = new Date(now);
		let at = localTime(base.getFullYear(), base.getMonth() + 1, base.getDate(), hour, minute);
		if (at === undefined) return { ok: false, reason: 'when-invalid' };
		if (at <= now) {
			const tomorrow = new Date(now + 86_400_000);
			at = localTime(tomorrow.getFullYear(), tomorrow.getMonth() + 1, tomorrow.getDate(), hour, minute);
		}
		return { ok: true, kind: 'every', everyMs: 86_400_000, at, label: `每天 ${daily[1]}:${daily[2]} · 下次 ${formatLocal(at)}` };
	}
	const clock = CLOCK_PATTERN.exec(first);
	if (clock !== null && parts.length === 1) {
		const hour = Number(clock[1]);
		const minute = Number(clock[2]);
		const base = new Date(now);
		let at = localTime(base.getFullYear(), base.getMonth() + 1, base.getDate(), hour, minute);
		if (at === undefined) return { ok: false, reason: 'when-invalid' };
		if (at <= now) {
			const tomorrow = new Date(now + 86_400_000);
			at = localTime(tomorrow.getFullYear(), tomorrow.getMonth() + 1, tomorrow.getDate(), hour, minute);
		}
		return { ok: true, kind: 'once', at, label: `一次性 · ${formatLocal(at)}` };
	}
	const absolute = ABSOLUTE_PATTERN.exec(`${first} ${second ?? ''}`.trim());
	if (absolute !== null && parts.length <= 2) {
		const at = localTime(
			Number(absolute[1]), Number(absolute[2]), Number(absolute[3]),
			Number(absolute[4]), Number(absolute[5]), Number(absolute[6] ?? 0),
		);
		if (at === undefined) return { ok: false, reason: 'when-invalid' };
		if (at <= now) return { ok: false, reason: 'when-in-past' };
		return { ok: true, kind: 'once', at, label: `一次性 · ${formatLocal(at)}` };
	}
	return { ok: false, reason: 'when-unparsed' };
}

/** Milliseconds of one entry's period, or 0 for a one-shot. */
function periodOf(entry) {
	return entry.kind === 'every' && Number.isFinite(entry.everyMs) && entry.everyMs > 0 ? entry.everyMs : 0;
}

/**
 * Step a periodic entry to its first slot strictly after `now`.
 *
 * Slots are `at + k·period` from the entry's own anchor, so a late firing never
 * shifts the schedule. `skipped` counts the slots at or before `now` that were
 * stepped over, starting from the entry's current `nextAt` — the caller decides
 * which of them were missed rather than run.
 * @param entry - one schedule entry.
 * @param now - current epoch milliseconds.
 * @returns `{ nextAt, skipped }`; a one-shot entry yields `{ nextAt: 0, skipped: 0 }`.
 */
function advance(entry, now) {
	const period = periodOf(entry);
	if (period === 0) return { nextAt: 0, skipped: 0 };
	const anchor = Number.isFinite(entry.nextAt) && entry.nextAt > 0 ? entry.nextAt : entry.at;
	if (!Number.isFinite(anchor) || anchor <= 0) return { nextAt: 0, skipped: 0 };
	let nextAt = anchor;
	let skipped = 0;
	while (nextAt <= now) {
		nextAt += period;
		skipped += 1;
	}
	return { nextAt, skipped };
}

/**
 * Classify every entry at one instant.
 * @param entries - all stored entries.
 * @param now - current epoch milliseconds.
 * @returns `{ due, missed, waiting }` where `due` items are inside the grace window.
 */
function classifyDue(entries, now = Date.now()) {
	const due = [];
	const missed = [];
	const waiting = [];
	for (const entry of Array.isArray(entries) ? entries : []) {
		if (!Number.isFinite(entry?.nextAt) || entry.nextAt <= 0) {
			waiting.push(entry);
			continue;
		}
		if (entry.nextAt > now) {
			waiting.push(entry);
			continue;
		}
		if (now - entry.nextAt > GRACE_MS) missed.push(entry);
		else due.push(entry);
	}
	return { due, missed, waiting };
}

/**
 * One trigger occurrence's identity, stable across restarts and re-scheduling.
 * @param entry - one schedule entry.
 * @param sequence - the entry's completed-occurrence counter.
 * @returns the occurrence id used as the submitted request id.
 */
function occurrenceId(entry, sequence) {
	return `${String(entry.id)}${OCCURRENCE_SEPARATOR}${String(sequence)}`;
}

/** One chat line describing an entry, including its timezone and next trigger. */
function describeEntry(entry) {
	const period = periodOf(entry);
	const schedule = period === 0
		? `一次性 ${formatLocal(entry.at)}`
		: entry.everyMs === 86_400_000 ? `每天 ${formatLocal(entry.at).slice(-5)}` : `每 ${Math.round(period / 60_000)} 分钟`;
	const state = entry.runs === undefined || entry.runs === 0 ? '' : ` · 已执行 ${entry.runs} 次`;
	const missed = entry.missed === undefined || entry.missed === 0 ? '' : ` · 错过 ${entry.missed} 次`;
	const next = entry.nextAt > 0 ? ` · 下次 ${formatLocal(entry.nextAt)}` : ' · 已完成';
	return `${entry.id} · ${schedule}${next} · ${entry.timeZone}${state}${missed}\n  ${entry.text}`;
}

/**
 * Apply one finished trigger to its entry.
 *
 * Exactly one slot is decided per call (the entry's current `nextAt`). Any
 * further slots that elapsed before this call were never run at all — the
 * service was down — so they are counted as missed and never executed late.
 * @param entry - the entry that fired (or was recorded as missed).
 * @param now - the instant the decision was made.
 * @param outcome - `'fired'`, `'missed'`, or `'failed'`.
 * @returns a new entry value; one-shot entries end with `nextAt: 0`.
 */
function applyOutcome(entry, now, outcome) {
	const next = {
		...entry,
		sequence: (Number.isFinite(entry.sequence) ? entry.sequence : 0) + 1,
		lastOutcome: outcome,
		lastRunAt: outcome === 'missed' ? entry.lastRunAt ?? 0 : now,
	};
	const stepped = advance(entry, now);
	const elapsedBeyondThis = Math.max(0, stepped.skipped - 1);
	const missedNow = (outcome === 'missed' ? 1 : 0) + elapsedBeyondThis;
	if (missedNow > 0) next.missed = (Number.isFinite(entry.missed) ? entry.missed : 0) + missedNow;
	if (outcome === 'fired') next.runs = (Number.isFinite(entry.runs) ? entry.runs : 0) + 1;
	next.nextAt = periodOf(entry) === 0 ? 0 : stepped.nextAt;
	return next;
}

/**
 * Split `/schedule add` arguments into the time expression and the task text.
 *
 * The split is by explicit form, never by guessing: a single-token time
 * (`+30m`, `09:30`) takes one argument, `daily`/`every` take two, and a date-time
 * takes two. Everything after that is the task text, verbatim.
 * @param args - the command arguments after `add`.
 * @returns `{ whenTokens, text }` or `{ error }`.
 */
function splitWhen(args) {
	const parts = (Array.isArray(args) ? args : []).filter((token) => typeof token === 'string' && token !== '');
	if (parts.length === 0) return { error: 'when-missing' };
	let width = 0;
	if (parts[0] === 'daily' || parts[0] === 'every') width = 2;
	else if (RELATIVE_PATTERN.test(parts[0]) || CLOCK_PATTERN.test(parts[0])) width = 1;
	else if (ABSOLUTE_PATTERN.test(`${parts[0]} ${parts[1] ?? ''}`.trim())) width = 2;
	else return { error: 'when-unparsed' };
	if (parts.length <= width) return { error: 'task-missing' };
	return { whenTokens: parts.slice(0, width), text: parts.slice(width).join(' ') };
}

export {
	ABSOLUTE_PATTERN, CLOCK_PATTERN, GRACE_MS, INTERVAL_PATTERN, OCCURRENCE_SEPARATOR,
	RELATIVE_PATTERN, TIME_FORMAT_NOTE, advance, applyOutcome, classifyDue, describeEntry,
	formatLocal, localTime, occurrenceId, parseWhen, periodOf, splitWhen, timeZoneLabel,
};
