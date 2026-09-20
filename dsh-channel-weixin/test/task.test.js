import assert from 'node:assert/strict';
import test from 'node:test';

import { NO_TEXT_REPLY, PLUGIN_SOURCE, TaskTracker, buildRequestMessage } from '../lib/task.js';

/** A tracker wired to recording transports. */
function tracker(options = {}) {
	const bodies = [];
	const statuses = [];
	const instance = new TaskTracker({
		requestId: options.requestId ?? 'req-1',
		sessionId: options.sessionId ?? 'session-1',
		now: options.now ?? (() => 1000),
		timeoutMs: options.timeoutMs ?? 60_000,
		streamFlushChars: options.streamFlushChars ?? 100,
		body: async (text) => { bodies.push(text); return options.bodyResult ?? { ok: true }; },
		status: async (text) => { statuses.push(text); return { ok: true }; },
	});
	return { instance, bodies, statuses };
}

/** One agent stand-in for a session. */
function agentFor(sessionId = 'session-1') {
	return { session: { id: sessionId } };
}

/** A session reference, as the app-level `session/event` payload supplies it. */
function sessionRef(sessionId = 'session-1') {
	return { id: sessionId };
}

/** One assistant frame carrying a visible text delta. */
function chunk(text, turn = 1) {
	return { type: 'chunk', turn, chunk: { type: 'text-delta', text } };
}

/** One durable session event record. */
function evt(type, data) {
	return { type, data };
}

test('the submitted message is harness-shaped and carries this plugin as its source', () => {
	const message = buildRequestMessage('req-9', '你好');
	assert.deepEqual(message, {
		id: 'req-9',
		role: 'user',
		content: [{ type: 'text', text: '你好' }],
		source: PLUGIN_SOURCE,
	});
	assert.equal(PLUGIN_SOURCE.plugin, 'dsh-channel-weixin');
});

test('nothing is attributed before the request is claimed', () => {
	const { instance, bodies } = tracker();
	instance.ingestFrame(agentFor(), chunk('别人的输出', 1));
	assert.equal(bodies.length, 0);
	assert.equal(instance.deliveredChars, 0);
});

test('only the claimed turn is attributed', () => {
	const { instance, bodies } = tracker();
	assert.equal(instance.claim('req-1', 4), true);
	instance.ingestFrame(agentFor(), chunk('other turn', 3));
	instance.ingestFrame(agentFor(), chunk('later turn', 5));
	instance.ingestFrame(agentFor(), chunk('我们的输出', 4));
	instance.ingestEvent(sessionRef(), evt('turn/end', { turn: 4 }));
	assert.deepEqual(bodies, ['📄 [req-1] [1/1]\n我们的输出', '✅ [req-1] 已完成 · 用时 0秒']);
});

test('a claim for a different message is refused', () => {
	const { instance } = tracker();
	assert.equal(instance.claim('other-request', 1), false);
	assert.equal(instance.turn, undefined);
	assert.equal(instance.claim('req-1', 2), true);
	assert.equal(instance.claim('req-1', 3), false, 'a second claim must not move the turn');
});

test('frames from another session are ignored', () => {
	const { instance, bodies } = tracker();
	instance.claim('req-1', 1);
	instance.ingestFrame(agentFor('session-2'), { type: 'chunk', turn: 1, chunk: { type: 'text-delta', text: 'x' } });
	instance.ingestEvent(sessionRef(), evt('turn/end', { turn: 1 }));
	assert.deepEqual(bodies, [`📄 [req-1]\n${NO_TEXT_REPLY}`, '✅ [req-1] 已完成 · 用时 0秒']);
});

test('reasoning and tool-call fragments never become reply text', () => {
	const { instance, bodies } = tracker();
	instance.claim('req-1', 1);
	instance.ingestFrame(agentFor(), { type: 'chunk', turn: 1, chunk: { type: 'reasoning-delta', text: '内部推理' } });
	instance.ingestFrame(agentFor(), { type: 'chunk', turn: 1, chunk: { type: 'tool-call-delta', argumentsDelta: '{"secret":1}' } });
	instance.ingestFrame(agentFor(), { type: 'chunk', turn: 1, chunk: { type: 'block-start', blockType: 'reasoning' } });
	instance.ingestFrame(agentFor(), chunk('对外文字', 1));
	instance.ingestEvent(sessionRef(), evt('turn/end', { turn: 1 }));
	assert.deepEqual(bodies, ['📄 [req-1] [1/1]\n对外文字', '✅ [req-1] 已完成 · 用时 0秒']);
});

test('long output streams in ordered segments that reassemble exactly', () => {
	const { instance, bodies } = tracker({ streamFlushChars: 50 });
	instance.claim('req-1', 1);
	const text = `${'句子一。'.repeat(30)}`;
	for (let index = 0; index < text.length; index += 10) {
		instance.ingestFrame(agentFor(), chunk(text.slice(index, index + 10), 1));
	}
	instance.ingestEvent(sessionRef(), evt('turn/end', { turn: 1 }));
	const pages = bodies.filter((body) => body.startsWith('📄'));
	assert.equal(pages.length > 1, true, 'expected more than one numbered segment');
	assert.equal(pages.map((body) => body.slice(body.indexOf('\n') + 1)).join(''), text);
	assert.match(bodies.at(-1), /^✅ \[req-1\] 已完成/);
	assert.equal(instance.deliveredChars > text.length, true);
});

test('tool status reports names and outcomes without arguments', () => {
	const { instance, statuses } = tracker();
	instance.claim('req-1', 1);
	instance.ingestEvent(sessionRef(), evt('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"rm -rf /"}' }));
	instance.ingestEvent(sessionRef(), evt('tool/result', { turn: 1, step: 1, message: { callId: 'c1' } }));
	instance.ingestEvent(sessionRef(), evt('tool/call', { turn: 1, step: 2, callId: 'c2', name: 'read' }));
	instance.ingestEvent(sessionRef(), evt('tool/result', { turn: 1, step: 2, message: { callId: 'c2' }, error: { code: 'X' } }));
	assert.deepEqual(statuses, [
		'▶️ [req-1] 已开始',
		'🔧 [req-1] 执行中：bash（共 1 次）',
		'🔧 [req-1] 执行中：bash、read（共 2 次）',
		'⚠️ [req-1] 工具 read 失败',
	]);
	assert.equal(statuses.join(' ').includes('rm -rf'), false, 'tool arguments must never be sent');
	assert.equal(instance.toolEvents, 4);
});

test('tool events from another turn or session are not attributed', () => {
	const { instance, statuses } = tracker();
	instance.claim('req-1', 2);
	instance.ingestEvent(sessionRef(), evt('tool/call', { turn: 1, callId: 'a', name: 'bash' }));
	instance.ingestEvent(sessionRef('session-9'), evt('tool/call', { turn: 2, callId: 'b', name: 'bash' }));
	assert.deepEqual(statuses, ['▶️ [req-1] 已开始']);
});

test('finishing with no text says so rather than sending nothing', () => {
	const { instance, bodies } = tracker();
	instance.claim('req-1', 1);
	const summary = instance.ingestEvent(sessionRef(), evt('turn/end', { turn: 1 })) === true ? instance.summary() : undefined;
	assert.deepEqual(bodies, [`📄 [req-1]\n${NO_TEXT_REPLY}`, '✅ [req-1] 已完成 · 用时 0秒']);
	assert.equal(summary.state, 'done');
	assert.equal(summary.turn, 1);
});

test('an agent error on this session becomes a failure reply once', () => {
	const { instance, bodies } = tracker();
	instance.claim('req-1', 1);
	instance.ingestError(agentFor(), new Error('provider exploded'));
	instance.ingestEvent(sessionRef(), evt('turn/end', { turn: 1 }));
	assert.deepEqual(bodies, ['❌ [req-1] 失败：provider exploded']);
	assert.equal(instance.summary().state, 'failed');
	assert.equal(instance.summary().error, 'provider exploded');
});

test('a failure keeps the text produced before it and still marks the failure', () => {
	const { instance, bodies } = tracker();
	instance.claim('req-1', 1);
	instance.ingestFrame(agentFor(), chunk('已经算出的部分结果', 1));
	instance.ingestError(agentFor(), new Error('provider exploded'));
	instance.ingestEvent(sessionRef(), evt('turn/end', { turn: 1 }));
	assert.deepEqual(bodies, ['📄 [req-1] [1/1]\n已经算出的部分结果', '❌ [req-1] 失败：provider exploded'], 'finished work is kept and the failure stays explicit');
	assert.equal(instance.summary().state, 'failed');
});

test('a cancelled task delivers neither its text nor a failure line', () => {
	const { instance, bodies } = tracker();
	instance.claim('req-1', 1);
	instance.ingestFrame(agentFor(), chunk('半截内容', 1));
	instance.abandon('stopped-by-user');
	instance.ingestEvent(sessionRef(), evt('turn/end', { turn: 1 }));
	assert.deepEqual(bodies, []);
	assert.equal(instance.summary().state, 'cancelled');
});

test('an error from another session is not attributed', () => {
	const { instance, bodies } = tracker();
	instance.claim('req-1', 1);
	assert.equal(instance.ingestError(agentFor('session-2'), new Error('nope')), false);
	instance.ingestEvent(sessionRef(), evt('turn/end', { turn: 1 }));
	assert.deepEqual(bodies, [`📄 [req-1]\n${NO_TEXT_REPLY}`, '✅ [req-1] 已完成 · 用时 0秒']);
});

test('an abandoned task reports cancellation and stops accepting output', () => {
	const { instance, bodies } = tracker();
	instance.claim('req-1', 1);
	instance.abandon('timeout');
	assert.equal(instance.summary().state, 'cancelled');
	assert.equal(instance.active, false);
	instance.ingestFrame(agentFor(), chunk('late text', 1));
	instance.ingestEvent(sessionRef(), evt('turn/end', { turn: 1 }));
	assert.deepEqual(bodies, []);
});

test('a second terminal boundary does not resend the answer', () => {
	const { instance, bodies } = tracker();
	instance.claim('req-1', 1);
	instance.ingestFrame(agentFor(), chunk('答案', 1));
	instance.ingestEvent(sessionRef(), evt('turn/end', { turn: 1 }));
	instance.ingestEvent(sessionRef(), evt('turn/end', { turn: 1 }));
	assert.deepEqual(bodies, ['📄 [req-1] [1/1]\n答案', '✅ [req-1] 已完成 · 用时 0秒']);
});

test('a delivery failure is recorded without re-running the task', async () => {
	const bodies = [];
	const instance = new TaskTracker({
		requestId: 'req-1',
		sessionId: 'session-1',
		now: () => 0,
		body: async (text) => { bodies.push(text); return { ok: false, error: 'context expired' }; },
		status: async () => ({ ok: true }),
	});
	instance.claim('req-1', 1);
	instance.ingestFrame(agentFor(), chunk('hi', 1));
	instance.ingestEvent(sessionRef(), evt('turn/end', { turn: 1 }));
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(bodies, ['📄 [req-1] [1/1]\nhi', '✅ [req-1] 已完成 · 用时 0秒']);
	assert.equal(instance.summary().bodyError, 'context expired');
	assert.equal(instance.summary().state, 'done', 'execution succeeded even though delivery did not');
});

test('the deadline is measured from submission', () => {
	let clock = 5000;
	const { instance } = tracker({ now: () => clock, timeoutMs: 1000 });
	assert.equal(instance.expired(), false);
	clock = 6500;
	assert.equal(instance.expired(), true);
	instance.claim('req-1', 1);
	instance.ingestEvent(sessionRef(), evt('turn/end', { turn: 1 }));
	assert.equal(instance.expired(), false, 'a finished task never expires');
});
