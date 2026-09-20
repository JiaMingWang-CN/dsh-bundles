import assert from 'node:assert/strict';
import test from 'node:test';

import {
	GRACE_MS, advance, applyOutcome, classifyDue, describeEntry, formatLocal, localTime,
	occurrenceId, parseWhen, periodOf, splitWhen, timeZoneLabel,
} from '../lib/schedule.js';

/** A fixed local reference instant: 2026-03-05 10:00:00 local time. */
const NOW = new Date(2026, 2, 5, 10, 0, 0, 0).getTime();

test('a relative time is a one-shot from now', () => {
	const parsed = parseWhen(['+30m'], NOW);
	assert.equal(parsed.ok, true);
	assert.equal(parsed.kind, 'once');
	assert.equal(parsed.at, NOW + 30 * 60_000);
	assert.match(parsed.label, /一次性/);
});

test('every supported unit works and a zero or negative amount is refused', () => {
	for (const [token, expected] of [['+45s', 45_000], ['+30m', 1_800_000], ['+2h', 7_200_000], ['+1d', 86_400_000]]) {
		assert.equal(parseWhen([token], NOW).at, NOW + expected);
	}
	assert.equal(parseWhen(['+0m'], NOW).reason, 'when-not-future');
});

test('a bare clock time means today, or tomorrow once it has passed', () => {
	const later = parseWhen(['18:30'], NOW);
	assert.equal(later.kind, 'once');
	assert.equal(new Date(later.at).getHours(), 18);
	assert.equal(new Date(later.at).getDate(), 5);
	const passed = parseWhen(['09:00'], NOW);
	assert.equal(new Date(passed.at).getDate(), 6, 'a time already past today must roll to tomorrow');
	assert.equal(passed.ok, true);
});

test('an absolute local time parses and a past one is refused', () => {
	const parsed = parseWhen(['2026-03-06', '09:30'], NOW);
	assert.equal(parsed.ok, true);
	assert.equal(new Date(parsed.at).getDate(), 6);
	assert.equal(new Date(parsed.at).getHours(), 9);
	assert.equal(parseWhen(['2026-03-01', '09:30'], NOW).reason, 'when-in-past');
	assert.equal(parseWhen(['2026-02-30', '09:30'], NOW).reason, 'when-invalid', 'an impossible calendar day is refused');
});

test('an impossible clock time is refused', () => {
	assert.equal(parseWhen(['25:00'], NOW).reason, 'when-invalid');
	assert.equal(parseWhen(['10:75'], NOW).reason, 'when-invalid');
	assert.equal(localTime(2026, 2, 30, 10, 0), undefined);
});

test('daily is a one-day period anchored at the given clock time', () => {
	const parsed = parseWhen(['daily', '07:15'], NOW);
	assert.equal(parsed.ok, true);
	assert.equal(parsed.kind, 'every');
	assert.equal(parsed.everyMs, 86_400_000);
	assert.equal(new Date(parsed.at).getHours(), 7);
	assert.equal(new Date(parsed.at).getDate(), 6, 'a daily time already past today starts tomorrow');
	assert.match(parsed.label, /每天 07:15/);
});

test('every is a fixed interval from now', () => {
	const minutes = parseWhen(['every', '30m'], NOW);
	assert.equal(minutes.kind, 'every');
	assert.equal(minutes.everyMs, 1_800_000);
	assert.equal(minutes.at, NOW + 1_800_000);
	const hours = parseWhen(['every', '2h'], NOW);
	assert.equal(hours.everyMs, 7_200_000);
	assert.equal(parseWhen(['every', '30s'], NOW).reason, 'when-unparsed', 'seconds are not a fixed interval here');
});

test('fuzzy natural language is refused, not guessed', () => {
	for (const tokens of [['明天早上'], ['tomorrow'], ['稍后'], ['晚一点'], ['next', 'monday'], []]) {
		const parsed = parseWhen(tokens, NOW);
		assert.equal(parsed.ok, false, `accepted fuzzy input: ${tokens.join(' ')}`);
	}
});

test('the timezone label names the zone and its offset', () => {
	const label = timeZoneLabel(NOW, 'Asia/Shanghai');
	assert.match(label, /Asia\/Shanghai/);
	assert.match(label, /UTC\+08:00/);
	assert.equal(typeof timeZoneLabel(NOW, undefined), 'string');
});

test('the add-arguments split is by explicit form, keeping the task text verbatim', () => {
	assert.deepEqual(splitWhen(['+30m', '跑', '测试']), { whenTokens: ['+30m'], text: '跑 测试' });
	assert.deepEqual(splitWhen(['daily', '09:30', '汇报']), { whenTokens: ['daily', '09:30'], text: '汇报' });
	assert.deepEqual(splitWhen(['2026-03-06', '09:30', '发布', '检查']), { whenTokens: ['2026-03-06', '09:30'], text: '发布 检查' });
	assert.deepEqual(splitWhen(['every', '2h', '同步']), { whenTokens: ['every', '2h'], text: '同步' });
	assert.equal(splitWhen(['明天早上', '任务']).error, 'when-unparsed');
	assert.equal(splitWhen(['+30m']).error, 'task-missing');
	assert.equal(splitWhen([]).error, 'when-missing');
});

test('advance lands on the first slot after now and counts what it stepped over', () => {
	const entry = { kind: 'every', everyMs: 60_000, nextAt: NOW };
	const onTime = advance(entry, NOW + 1000);
	assert.equal(onTime.nextAt, NOW + 60_000, 'the slot just handled is not offered again');
	assert.equal(onTime.skipped, 1);
	const late = advance(entry, NOW + 10 * 60_000);
	assert.equal(late.nextAt, NOW + 11 * 60_000);
	assert.equal(late.skipped, 11, 'every elapsed slot is accounted for');
});

test('a one-shot entry has no next slot after firing', () => {
	const entry = { id: 'sched-1', kind: 'once', everyMs: 0, at: NOW, nextAt: NOW };
	assert.equal(periodOf(entry), 0);
	assert.deepEqual(advance(entry, NOW), { nextAt: 0, skipped: 0 });
	const settled = applyOutcome(entry, NOW, 'fired');
	assert.equal(settled.nextAt, 0);
	assert.equal(settled.runs, 1);
	assert.equal(settled.sequence, 1);
});

test('a due entry inside the grace window fires, one beyond it is missed', () => {
	const onTime = { id: 'a', nextAt: NOW };
	const late = { id: 'b', nextAt: NOW - GRACE_MS - 1 };
	const future = { id: 'c', nextAt: NOW + 1000 };
	const classified = classifyDue([onTime, late, future], NOW);
	assert.deepEqual(classified.due.map((entry) => entry.id), ['a']);
	assert.deepEqual(classified.missed.map((entry) => entry.id), ['b']);
	assert.deepEqual(classified.waiting.map((entry) => entry.id), ['c']);
});

test('a missed occurrence advances the schedule without running it', () => {
	const entry = { id: 'sched-2', kind: 'every', everyMs: 3_600_000, at: NOW, nextAt: NOW, runs: 4, missed: 1, sequence: 5 };
	const settled = applyOutcome(entry, NOW + 5 * 3_600_000, 'missed');
	assert.equal(settled.runs, 4, 'a missed trigger must not count as a run');
	assert.equal(settled.missed, 7, 'the decided slot plus the five slots stepped over while down');
	assert.equal(settled.sequence, 6);
	assert.equal(settled.nextAt, NOW + 6 * 3_600_000);
	assert.equal(settled.lastOutcome, 'missed');
});

test('a fired periodic occurrence keeps the original anchor', () => {
	const entry = { id: 'sched-3', kind: 'every', everyMs: 60_000, at: NOW, nextAt: NOW, runs: 0, missed: 0, sequence: 0 };
	const settled = applyOutcome(entry, NOW + 1, 'fired');
	assert.equal(settled.runs, 1);
	assert.equal(settled.missed, 0, 'a punctual firing misses nothing');
	assert.equal(settled.nextAt, NOW + 60_000, 'the schedule must not drift with the firing time');
});

test('a failed occurrence advances the schedule and is recorded', () => {
	const entry = { id: 'sched-4', kind: 'every', everyMs: 60_000, at: NOW, nextAt: NOW, runs: 2, missed: 0, sequence: 2 };
	const settled = applyOutcome(entry, NOW + 1, 'failed');
	assert.equal(settled.runs, 2, 'a failure is not a successful run');
	assert.equal(settled.missed, 0);
	assert.equal(settled.sequence, 3);
	assert.equal(settled.lastOutcome, 'failed');
	assert.equal(settled.nextAt, NOW + 60_000);
});

test('occurrence ids are stable and distinct per firing', () => {
	const entry = { id: 'sched-7' };
	assert.equal(occurrenceId(entry, 0), 'sched-7#0');
	assert.equal(occurrenceId(entry, 3), 'sched-7#3');
	assert.notEqual(occurrenceId(entry, 3), occurrenceId(entry, 4));
});

test('a listing line carries the schedule, the timezone, and the next trigger', () => {
	const entry = {
		id: 'sched-1',
		kind: 'every',
		everyMs: 86_400_000,
		at: NOW,
		nextAt: NOW + 86_400_000,
		timeZone: 'Asia/Shanghai (UTC+8)',
		runs: 2,
		missed: 1,
		text: '每日构建',
	};
	const line = describeEntry(entry);
	assert.match(line, /sched-1/);
	assert.match(line, /每天/);
	assert.match(line, /下次/);
	assert.match(line, /Asia\/Shanghai/);
	assert.match(line, /已执行 2 次/);
	assert.match(line, /错过 1 次/);
	assert.match(line, /每日构建/);
});

test('a one-shot listing line says the entry is finished once it fired', () => {
	const line = describeEntry({ id: 'sched-2', kind: 'once', everyMs: 0, at: NOW, nextAt: 0, timeZone: '本地时区', text: 'x' });
	assert.match(line, /已完成/);
});

test('formatLocal renders a stable local wall clock', () => {
	const painted = formatLocal(new Date(2026, 0, 2, 3, 4).getTime());
	assert.equal(painted, '2026-01-02 03:04');
});
