import assert from 'node:assert/strict';
import test from 'node:test';

import { SendScheduler, findSplit, formatWeixinText, safeBoundary, segmentText } from '../lib/reply.js';
import { clientId, pollUpdates, quoteLargeIntegers, sendText, sendTyping, testing as protocol } from '../lib/weixin.js';

/** A fetch stand-in returning one canned body and recording requests. */
function fakeFetch(body, { raw, ok = true, status = 200, fail } = {}) {
	const calls = [];
	const impl = async (url, options) => {
		calls.push({ url: String(url), options });
		if (fail !== undefined) throw fail;
		return {
			ok,
			status,
			text: async () => (raw !== undefined ? raw : JSON.stringify(body)),
		};
	};
	impl.calls = calls;
	return impl;
}

/* ------------------------------------------------------------------ *
 * Segmentation
 * ------------------------------------------------------------------ */

test('Markdown is normalized into readable WeChat plain text', () => {
	const source = '# 标题\n\n**重点**与[链接](https://example.com)\n\n| 名称 | 值 |\n| --- | --- |\n| 模型 | A |\n\n```js\nconst x = 1;\n```';
	assert.equal(formatWeixinText(source), '【标题】\n\n重点与链接（https://example.com）\n\n名称 ｜ 值\n模型 ｜ A\n\n【代码】\nconst x = 1;\n【代码结束】');
});

test('a short reply is one segment', () => {
	assert.deepEqual(segmentText('简短回复'), ['简短回复']);
	assert.deepEqual(segmentText(''), []);
});

test('segments concatenate back to the original text exactly', () => {
	const text = `${'第一段。'.repeat(80)}\n\n${'second paragraph. '.repeat(60)}尾`;
	for (const limit of [40, 120, 400]) {
		const segments = segmentText(text, limit);
		assert.equal(segments.join(''), text, `limit ${limit} lost or duplicated text`);
	}
});

test('segmentation prefers paragraph and sentence boundaries', () => {
	const text = `${'a'.repeat(30)}\n\n${'b'.repeat(30)}`;
	const segments = segmentText(text, 40);
	assert.equal(segments[0].endsWith('\n\n'), true);
	assert.equal(segments.join(''), text);
	const sentence = segmentText(`${'字'.repeat(20)}。${'字'.repeat(20)}`, 25);
	assert.equal(sentence[0].endsWith('。'), true);
});

test('a long unbroken token is still split rather than sent oversized', () => {
	const text = 'x'.repeat(5000);
	const segments = segmentText(text, 1000);
	assert.equal(segments.length, 5);
	assert.equal(segments.every((segment) => segment.length <= 1000), true);
	assert.equal(segments.join(''), text);
});

test('a split never separates a surrogate pair', () => {
	const emoji = '😀'.repeat(10);
	const segments = segmentText(emoji, 3);
	assert.equal(segments.join(''), emoji);
	for (const segment of segments) {
		assert.equal(/[\uD800-\uDBFF]$/.test(segment), false, 'segment ends on a high surrogate');
		assert.equal(/^[\uDC00-\uDFFF]/.test(segment), false, 'segment starts on a low surrogate');
	}
});

test('the boundary helpers refuse to cut a pair and fall back to the limit', () => {
	assert.equal(safeBoundary('😀', 1), 0);
	assert.equal(safeBoundary('ab', 1), 1);
	assert.equal(safeBoundary('ab', 0), 0);
	assert.equal(findSplit('short', 100), 5);
});

/* ------------------------------------------------------------------ *
 * Send scheduler
 * ------------------------------------------------------------------ */

test('body text is delivered serially in order with a minimum gap', async () => {
	const sent = [];
	let clock = 0;
	const scheduler = new SendScheduler({
		send: async (text) => { sent.push(text); clock += 10; },
		minIntervalMs: 100,
		now: () => clock,
		sleep: async (ms) => { clock += ms; },
	});
	await Promise.all([
		scheduler.enqueue('body', 'one'),
		scheduler.enqueue('body', 'two'),
		scheduler.enqueue('body', 'three'),
	]);
	assert.deepEqual(sent, ['one', 'two', 'three']);
	assert.equal(clock >= 200, true, 'gap was not applied between sends');
});

test('task correlation metadata reaches every scheduled send', async () => {
	const calls = [];
	const scheduler = new SendScheduler({
		send: async (text, kind, metadata) => { calls.push({ text, kind, metadata }); },
		minIntervalMs: 0,
		now: () => 0,
		sleep: async () => {},
	});
	await scheduler.enqueue('body', 'answer', { runId: 'run-1', contextToken: 'ctx-1' });
	assert.deepEqual(calls, [{ text: 'answer', kind: 'body', metadata: { runId: 'run-1', contextToken: 'ctx-1' } }]);
});

test('a superseded status settles and a status behind a body is dropped', async () => {
	const sent = [];
	const gate = Promise.withResolvers();
	const scheduler = new SendScheduler({
		send: async (text) => {
			sent.push(text);
			if (text === 'answer') await gate.promise;
		},
		minIntervalMs: 0,
		now: () => 0,
		sleep: async () => {},
	});
	const first = scheduler.enqueue('body', 'answer');
	/* Wait until the first send is actually in flight, so the rest queue behind it. */
	while (sent.length === 0) await new Promise((resolve) => setImmediate(resolve));
	const statusA = scheduler.enqueue('status', 'tool A');
	const statusB = scheduler.enqueue('status', 'tool B');
	const second = scheduler.enqueue('body', 'answer 2');
	gate.resolve();
	const [firstResult, statusAResult, statusBResult, secondResult] = await Promise.all([first, statusA, statusB, second]);
	assert.deepEqual(sent, ['answer', 'answer 2'], 'status chatter must not interleave with the answer');
	assert.deepEqual(firstResult, { ok: true });
	assert.deepEqual(statusAResult, { ok: false, dropped: 'superseded' });
	assert.deepEqual(statusBResult, { ok: false, dropped: 'superseded-by-body' });
	assert.deepEqual(secondResult, { ok: true });
});

test('a failed status never reaches the caller as an error', async () => {
	const scheduler = new SendScheduler({
		send: async () => { throw new Error('rate limited'); },
		minIntervalMs: 0,
		now: () => 0,
		sleep: async () => {},
	});
	const result = await scheduler.enqueue('status', 'typing');
	assert.deepEqual(result, { ok: false, dropped: 'status-failed' });
});

test('a failed body reports its own error to its own caller', async () => {
	const scheduler = new SendScheduler({
		send: async () => { throw new Error('context expired'); },
		minIntervalMs: 0,
		now: () => 0,
		sleep: async () => {},
	});
	const result = await scheduler.enqueue('body', 'answer');
	assert.equal(result.ok, false);
	assert.match(result.error, /context expired/);
});

test('a status queued behind nothing is sent', async () => {
	const sent = [];
	const scheduler = new SendScheduler({
		send: async (text) => { sent.push(text); },
		minIntervalMs: 0,
		now: () => 0,
		sleep: async () => {},
	});
	const result = await scheduler.enqueue('status', '正在处理');
	assert.deepEqual(result, { ok: true });
	assert.deepEqual(sent, ['正在处理']);
});

/* ------------------------------------------------------------------ *
 * Protocol: getupdates / sendmessage / typing
 * ------------------------------------------------------------------ */

test('uint64 identifiers survive JSON parsing as strings', () => {
	const raw = '{"message_id":18446744073709551615,"create_time_ms":1700000000000,"seq":7}';
	const parsed = JSON.parse(quoteLargeIntegers(raw));
	assert.equal(parsed.message_id, '18446744073709551615');
	assert.equal(parsed.create_time_ms, 1700000000000, 'ordinary numbers keep their type');
	assert.equal(parsed.seq, 7);
});

test('a long-poll timeout is reported as no messages, not an error', async () => {
	const abort = new Error('aborted');
	abort.name = 'AbortError';
	const result = await pollUpdates({ fetchImpl: fakeFetch(null, { fail: abort }), token: 't', version: '1.0.0', cursor: 'c1' });
	assert.deepEqual(result, { messages: [], cursor: 'c1', stale: false, timedOut: true });
});

test('the updates request carries the cursor and the plugin identity', async () => {
	const fetchImpl = fakeFetch({ ret: 0, msgs: [], get_updates_buf: '' });
	await pollUpdates({ fetchImpl, token: 'bot-token', version: '0.2.0', cursor: 'cursor-1', random: () => 0.5 });
	const [call] = fetchImpl.calls;
	assert.equal(call.url, 'https://ilinkai.weixin.qq.com/ilink/bot/getupdates');
	assert.equal(call.options.method, 'POST');
	assert.equal(call.options.headers.Authorization, 'Bearer bot-token');
	const body = JSON.parse(call.options.body);
	assert.equal(body.get_updates_buf, 'cursor-1');
	assert.equal(body.base_info.bot_agent, protocol.BOT_AGENT);
	assert.equal(body.base_info.channel_version, '0.2.0');
});

test('a non-empty answer cursor advances, an empty one keeps the old cursor', async () => {
	const advanced = await pollUpdates({ fetchImpl: fakeFetch({ ret: 0, msgs: [], get_updates_buf: 'next' }), token: 't', version: '1', cursor: 'old' });
	assert.equal(advanced.cursor, 'next');
	const kept = await pollUpdates({ fetchImpl: fakeFetch({ ret: 0, msgs: [], get_updates_buf: '' }), token: 't', version: '1', cursor: 'old' });
	assert.equal(kept.cursor, 'old');
});

test('messages are returned and non-object entries are dropped', async () => {
	const fetchImpl = fakeFetch({ ret: 0, msgs: [{ message_id: 'm-1' }, null, 'x'], get_updates_buf: 'c' });
	const result = await pollUpdates({ fetchImpl, token: 't', version: '1' });
	assert.equal(result.messages.length, 1);
	assert.equal(result.messages[0].message_id, 'm-1');
});

test('a stale credential is surfaced instead of retried', async () => {
	const result = await pollUpdates({ fetchImpl: fakeFetch({ ret: 0, errcode: -14 }), token: 't', version: '1', cursor: 'c' });
	assert.equal(result.stale, true);
	assert.equal(result.cursor, 'c');
});

test('another business failure throws with its codes', async () => {
	await assert.rejects(
		() => pollUpdates({ fetchImpl: fakeFetch({ ret: -1, errcode: -2, errmsg: 'bad' }), token: 't', version: '1' }),
		/ret=-1 errcode=-2 bad/,
	);
});

test('the server-suggested long-poll timeout is honored but bounded', async () => {
	const short = await pollUpdates({ fetchImpl: fakeFetch({ ret: 0, longpolling_timeout_ms: 20000 }), token: 't', version: '1' });
	assert.equal(short.suggestedTimeoutMs, 20000);
	const huge = await pollUpdates({ fetchImpl: fakeFetch({ ret: 0, longpolling_timeout_ms: 999999 }), token: 't', version: '1' });
	assert.equal(huge.suggestedTimeoutMs, 120000);
});

test('outbound text carries the documented shape and no media', async () => {
	const fetchImpl = fakeFetch({ ret: 0, message_id: '9007199254740993' });
	const result = await sendText({
		fetchImpl, token: 'bot-token', version: '0.2.0', toUserId: 'user-1', text: '你好', contextToken: 'ctx', runId: 'run-1', random: () => 0.25, now: () => 42,
	});
	const body = JSON.parse(fetchImpl.calls[0].options.body);
	assert.equal(body.msg.to_user_id, 'user-1');
	assert.equal(body.msg.message_type, 2);
	assert.equal(body.msg.message_state, 2);
	assert.equal(body.msg.context_token, 'ctx');
	assert.equal(body.msg.run_id, 'run-1');
	assert.deepEqual(body.msg.item_list, [{ type: 1, text_item: { text: '你好' } }]);
	assert.equal(body.msg.client_id.startsWith('dsh-channel-weixin:42-'), true);
	assert.equal(result.messageId, '9007199254740993', 'uint64 message id must survive as a string');
});

test('outbound text omits an empty context token rather than sending one', async () => {
	const fetchImpl = fakeFetch({ ret: 0 });
	await sendText({ fetchImpl, token: 't', version: '1', toUserId: 'u', text: 'x', contextToken: '' });
	assert.equal('context_token' in JSON.parse(fetchImpl.calls[0].options.body).msg, false);
});

test('a rejected send throws with the server code', async () => {
	await assert.rejects(
		() => sendText({ fetchImpl: fakeFetch({ ret: -1, errmsg: 'blocked' }), token: 't', version: '1', toUserId: 'u', text: 'x' }),
		/ret=-1 blocked/,
	);
});

test('the client id is unique per call and names this plugin', () => {
	const first = clientId(() => 1000, () => 0.5);
	const second = clientId(() => 1000, () => 0.6);
	assert.equal(first.startsWith('dsh-channel-weixin:1000-'), true);
	assert.notEqual(first, second);
	assert.equal(first.includes('openclaw'), false);
});

test('typing is best-effort: a transport failure reports false instead of throwing', async () => {
	const failed = await sendTyping({ fetchImpl: fakeFetch(null, { fail: new Error('down') }), token: 't', version: '1', peerUserId: 'u', typingTicket: 'ticket', status: 1 });
	assert.equal(failed, false);
	const noTicket = await sendTyping({ fetchImpl: fakeFetch({ ret: 0 }), token: 't', version: '1', peerUserId: 'u', typingTicket: '', status: 1 });
	assert.equal(noTicket, false);
});
