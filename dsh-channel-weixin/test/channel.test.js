import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ChannelLoop, NO_BINDING_REPLY } from '../lib/channel.js';
import * as storage from '../lib/storage.js';

const ACCOUNT = { botToken: 'bot-token', userId: 'user-1', botId: 'bot-1', baseUrl: 'https://weixin.qq.com' };

/** One inbound text message from the bound user. */
function message(id, text, extra = {}) {
	return {
		message_id: id,
		from_user_id: 'user-1',
		message_type: 1,
		create_time_ms: 1000,
		context_token: 'ctx-1',
		item_list: [{ type: 1, text_item: { text } }],
		...extra,
	};
}

/** A loop with recording transports and fake DSH services. */
function makeLoop({ messages = [], cursor = 'cursor-1', binding, agent, live = true, resume, pollError, stale = false, discardInitialBacklog = false, transport: transportOverrides = {} } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'channel-weixin-loop-'));
	if (binding !== undefined) storage.writeBinding(root, binding.peer ?? 'user-1', { sessionId: binding.sessionId, cwd: binding.cwd ?? '' });
	const sent = [];
	const sentCalls = [];
	const events = [];
	const submitted = [];
	const tickets = [];
	const typingCalls = [];
	/** The live agent, or undefined when the session is not currently running. */
	const running = live ? (agent ?? { followup: (given) => { submitted.push(given); } }) : undefined;
	const transport = {
		async pollUpdates() {
			if (pollError !== undefined) throw pollError;
			return { messages, cursor, stale, timedOut: false };
		},
		async sendText(options) { sent.push(options.text); sentCalls.push(options); return { ok: true, messageId: 'm' }; },
		async fetchTypingTicket() { tickets.push('fetched'); return 'ticket-1'; },
		async sendTyping({ status }) { typingCalls.push(status); return true; },
		...transportOverrides,
	};
	const agents = {
		get: (id) => (running !== undefined && (binding === undefined || id === binding.sessionId) ? running : undefined),
		resume: resume ?? (async () => { throw new Error('resume not expected'); }),
		create: async () => { throw new Error('create not expected'); },
		roots: () => (running === undefined ? [] : [running]),
	};
	const loop = new ChannelLoop({
		account: ACCOUNT,
		root,
		agents,
		permissionPresets: { set: () => {} },
		persistence: undefined,
		storage,
		transport,
		version: '0.3.0',
		now: () => 1000,
		sleep: async () => {},
		onStatus: (event) => events.push(event),
		discardInitialBacklog,
	});
	return {
		loop, root, sent, sentCalls, events, submitted, tickets, typingCalls, running, agents,
		async flush() { for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve)); },
		dispose() { rmSync(root, { recursive: true, force: true }); },
	};
}

test('an unbound peer asking for a task is told how to bind', async () => {
	const harness = makeLoop({ messages: [message('m-1', '帮我跑测试')] });
	try {
		await harness.loop.tick();
		await harness.flush();
		assert.deepEqual(harness.sent, [NO_BINDING_REPLY]);
		assert.deepEqual(harness.submitted, [], 'nothing may be submitted without a binding');
	} finally {
		harness.dispose();
	}
});

test('a task is submitted into the bound session and the cursor moves with its record', async () => {
	const harness = makeLoop({ messages: [message('m-2', '跑一下测试')], binding: { sessionId: 'session-1', cwd: 'C:\\w' }, cursor: 'cursor-2' });
	try {
		await harness.loop.tick();
		await harness.flush();
		assert.equal(harness.submitted.length, 1);
		assert.equal(harness.submitted[0].id, 'weixin-m-2');
		assert.equal(harness.submitted[0].role, 'user');
		assert.equal(harness.submitted[0].content[0].text, '跑一下测试');
		assert.equal(harness.submitted[0].source.plugin, 'dsh-channel-weixin');
		const state = storage.readChannelState(harness.root);
		assert.equal(state.cursor, 'cursor-2');
		assert.deepEqual(state.seenIds, ['m-2']);
		assert.equal(harness.events.some((event) => event.kind === 'submitted'), true);
	} finally {
		harness.dispose();
	}
});

test('the first poll establishes a cursor baseline without executing backlog', async () => {
	const harness = makeLoop({
		messages: [message('old-1', '旧任务'), message('old-2', '/help')],
		binding: { sessionId: 'session-1' },
		discardInitialBacklog: true,
	});
	try {
		assert.equal(await harness.loop.tick(), 'baseline');
		assert.deepEqual(harness.submitted, []);
		assert.deepEqual(storage.readChannelState(harness.root).seenIds, ['old-1', 'old-2']);
		assert.equal(harness.events.filter((event) => event.kind === 'offline-message-skipped').length, 2);
		assert.match(harness.sent[0], /请重新发送/);
	} finally {
		harness.dispose();
	}
});

test('after the cursor baseline, server timestamps are not compared with the host clock', async () => {
	const harness = makeLoop({
		messages: [message('skewed-1', '执行任务', { create_time_ms: 1 })],
		binding: { sessionId: 'session-1' },
	});
	try {
		await harness.loop.tick();
		assert.equal(harness.submitted.length, 1);
		assert.equal(harness.submitted[0].id, 'weixin-skewed-1');
	} finally {
		harness.dispose();
	}
});

test('a command is answered instead of submitted as a task', async () => {
	const harness = makeLoop({ messages: [message('m-3', '/help')], binding: { sessionId: 'session-1' } });
	try {
		await harness.loop.tick();
		await harness.flush();
		assert.deepEqual(harness.submitted, []);
		assert.equal(harness.sent.length, 1);
		assert.match(harness.sent[0], /可用命令/);
	} finally {
		harness.dispose();
	}
});

test('a duplicate message is handled once even across a cursor rewind', async () => {
	const harness = makeLoop({ messages: [message('m-4', '/cwd')], binding: { sessionId: 'session-1' } });
	try {
		await harness.loop.tick();
		await harness.flush();
		const first = harness.sent.length;
		/* The server replays the same batch with the same message id. */
		await harness.loop.tick();
		await harness.flush();
		assert.equal(harness.sent.length, first, 'a replayed message must not be answered twice');
	} finally {
		harness.dispose();
	}
});

test("another sender in the same batch is dropped", async () => {
	const harness = makeLoop({
		messages: [message('m-5', '你好', { from_user_id: 'someone-else' }), message('m-6', '/cwd')],
		binding: { sessionId: 'session-1', cwd: 'C:\\w' },
	});
	try {
		await harness.loop.tick();
		await harness.flush();
		assert.equal(harness.sent.length, 1);
		assert.match(harness.sent[0], /C:\\w/);
	} finally {
		harness.dispose();
	}
});

test('a stale credential stops the loop and is reported once', async () => {
	const harness = makeLoop({ stale: true });
	try {
		const outcome = await harness.loop.tick();
		assert.equal(outcome, 'stale');
		assert.equal(harness.loop.stopped, true);
		assert.equal(harness.events.some((event) => event.kind === 'stale-credential'), true);
		assert.equal(await harness.loop.tick(), 'stopped');
	} finally {
		harness.dispose();
	}
});

test('a transport failure backs off and retries instead of throwing', async () => {
	const harness = makeLoop({ pollError: new Error('socket down') });
	try {
		assert.equal(await harness.loop.tick(), 'retry');
		assert.equal(harness.loop.failures, 1);
		assert.equal(harness.events.at(-1).kind, 'poll-failed');
		assert.equal(harness.loop.stopped, false);
	} finally {
		harness.dispose();
	}
});

test('a bound session that is not live is resumed before submitting', async () => {
	const resumed = [];
	const harness = makeLoop({
		messages: [message('m-7', '继续')],
		binding: { sessionId: 'session-stored' },
		live: false,
		resume: async ({ resumeSessionId }) => {
			resumed.push(resumeSessionId);
			return { agent: { followup: (given) => harness.submitted.push(given) } };
		},
	});
	try {
		await harness.loop.tick();
		await harness.flush();
		assert.deepEqual(resumed, ['session-stored']);
		assert.equal(harness.submitted.length, 1);
	} finally {
		harness.dispose();
	}
});

test('a resume failure is reported and no task is submitted', async () => {
	const harness = makeLoop({
		messages: [message('m-8', '继续')],
		binding: { sessionId: 'session-gone' },
		live: false,
		resume: async () => { throw new Error('unknown session'); },
	});
	try {
		await harness.loop.tick();
		await harness.flush();
		assert.equal(harness.submitted.length, 0);
		assert.match(harness.sent[0], /无法恢复/);
	} finally {
		harness.dispose();
	}
});

test('a submit failure is reported and leaves no tracker behind', async () => {
	const harness = makeLoop({
		messages: [message('m-9', '跑')],
		binding: { sessionId: 'session-1' },
		agent: { followup: () => { throw new Error('inbox closed'); } },
	});
	try {
		await harness.loop.tick();
		await harness.flush();
		assert.equal(harness.loop.trackers.size, 0);
		assert.match(harness.sent[0], /任务提交失败：inbox closed/);
	} finally {
		harness.dispose();
	}
});

test('the answer is attributed by the inbox claim and delivered on turn end', async () => {
	const harness = makeLoop({ messages: [message('m-10', '你好')], binding: { sessionId: 'session-1' } });
	try {
		await harness.loop.tick();
		await harness.flush();
		const requestId = 'weixin-m-10';
		assert.equal(harness.loop.trackers.has(requestId), true);
		harness.loop.onInboxClaimed({ id: requestId }, 7);
		/* A later inbound message must not replace this task's reply correlation. */
		harness.loop.contextToken = 'newer-context';
		const agent = { session: { id: 'session-1' } };
		harness.loop.onAgentFrame(agent, { type: 'chunk', turn: 7, chunk: { type: 'text-delta', text: '这是答案' } });
		harness.loop.onSessionEvent({ id: 'session-1' }, { type: 'turn/end', data: { turn: 7 } });
		await harness.flush();
		assert.equal(harness.sent.some((text) => text.includes('这是答案')), true);
		const answerCall = harness.sentCalls.find((call) => call.text.includes('这是答案'));
		assert.equal(answerCall.runId, requestId);
		assert.equal(answerCall.contextToken, 'ctx-1');
		assert.equal(harness.loop.trackers.size, 0, 'a settled tracker must be retired');
		assert.equal(harness.events.some((event) => event.kind === 'settled' && event.state === 'done'), true);
		assert.equal(harness.typingCalls.includes(2), true, 'typing must be cleared when the task settles');
	} finally {
		harness.dispose();
	}
});

test('output of an unrelated turn never reaches the peer', async () => {
	const harness = makeLoop({ messages: [message('m-11', '你好')], binding: { sessionId: 'session-1' } });
	try {
		await harness.loop.tick();
		await harness.flush();
		const requestId = 'weixin-m-11';
		harness.loop.onInboxClaimed({ id: requestId }, 2);
		const agent = { session: { id: 'session-1' } };
		harness.loop.onAgentFrame(agent, { type: 'chunk', turn: 1, chunk: { type: 'text-delta', text: '网页那边的输出' } });
		harness.loop.onAgentFrame(agent, { type: 'chunk', turn: 2, chunk: { type: 'text-delta', text: '微信的输出' } });
		harness.loop.onSessionEvent({ id: 'session-1' }, { type: 'turn/end', data: { turn: 2 } });
		await harness.flush();
		assert.deepEqual(harness.sent, [
			'▶️ [m-11] 已开始',
			'📄 [m-11] [1/1]\n微信的输出',
			'✅ [m-11] 已完成 · 用时 0秒',
		]);
	} finally {
		harness.dispose();
	}
});

test('tool events for the claimed turn become status lines without arguments', async () => {
	const harness = makeLoop({ messages: [message('m-12', '跑测试')], binding: { sessionId: 'session-1' } });
	try {
		await harness.loop.tick();
		await harness.flush();
		harness.loop.onInboxClaimed({ id: 'weixin-m-12' }, 3);
		const session = { id: 'session-1' };
		harness.loop.onSessionEvent(session, { type: 'tool/call', data: { turn: 3, callId: 'c1', name: 'pwsh', arguments: '{"command":"secret"}' } });
		harness.loop.onSessionEvent(session, { type: 'tool/result', data: { turn: 3, message: { callId: 'c1' } } });
		await harness.flush();
		assert.deepEqual(harness.sent, ['▶️ [m-12] 已开始', '🔧 [m-12] 执行中：pwsh（共 1 次）']);
		assert.equal(harness.sent.some((text) => text.includes('secret')), false);
		assert.equal(harness.loop.trackers.size, 1, 'status chatter must not settle the task');
	} finally {
		harness.dispose();
	}
});

test('an expired task is abandoned and reported once', async () => {
	let clock = 0;
	const harness = makeLoop({ messages: [message('m-13', '长任务')], binding: { sessionId: 'session-1' } });
	try {
		harness.loop.now = () => clock;
		await harness.loop.tick();
		await harness.flush();
		for (const tracker of harness.loop.trackers.values()) tracker.timeoutMs = 1000;
		clock = 5000;
		harness.loop.sweepExpired();
		await harness.flush();
		assert.equal(harness.loop.trackers.size, 0);
		assert.equal(harness.events.some((event) => event.kind === 'timeout'), true);
		assert.equal(harness.sent.some((text) => text.includes('任务超时')), true);
	} finally {
		harness.dispose();
	}
});

test('stopping the loop abandons running trackers', async () => {
	const harness = makeLoop({ messages: [message('m-14', '任务')], binding: { sessionId: 'session-1' } });
	try {
		await harness.loop.tick();
		await harness.flush();
		const tracker = [...harness.loop.trackers.values()][0];
		harness.loop.stop('plugin-unload');
		assert.equal(tracker.summary().state, 'cancelled');
		assert.equal(harness.loop.trackers.size, 0);
	} finally {
		harness.dispose();
	}
});

test('a batch with no messages still advances a changed cursor', async () => {
	const harness = makeLoop({ messages: [], cursor: 'cursor-9' });
	try {
		await harness.loop.tick();
		assert.equal(storage.readChannelState(harness.root).cursor, 'cursor-9');
	} finally {
		harness.dispose();
	}
});

test('the typing ticket is fetched once and reused', async () => {
	const harness = makeLoop({ messages: [], cursor: 'cursor-1' });
	try {
		await harness.loop.typing(1);
		await harness.loop.typing(1);
		assert.deepEqual(harness.tickets, ['fetched']);
		assert.deepEqual(harness.typingCalls, [1, 1]);
	} finally {
		harness.dispose();
	}
});

test('the run loop exits when the credential goes stale', async () => {
	const harness = makeLoop({ stale: true });
	try {
		await harness.loop.run();
		assert.equal(harness.loop.stopped, true);
	} finally {
		harness.dispose();
	}
});

test('a task arriving while the queue is paused is held back, not submitted', async () => {
	const harness = makeLoop({ binding: { sessionId: 'session-1' } });
	try {
		harness.loop.paused.add('session-1');
		await harness.loop.submitTask('再跑一个', { fromUserId: 'user-1', messageId: 'm-p1' });
		await harness.flush();
		assert.deepEqual(harness.submitted, [], 'a paused session must not accept new work');
		assert.match(harness.sent[0], /队列处于暂停状态/);
		assert.match(harness.sent[0], /\/queue resume/);
	} finally {
		harness.dispose();
	}
});

test('/stop pauses the session and /queue resume lifts it', async () => {
	const harness = makeLoop({ binding: { sessionId: 'session-1' } });
	try {
		harness.running.status = 'running';
		harness.running.cancel = () => {};
		await harness.loop.handleText({ text: '/stop', fromUserId: 'user-1', messageId: 'm-stop' });
		await harness.flush();
		assert.equal(harness.loop.paused.has('session-1'), true);
		harness.running.inbox = { nextTurn: [], nextStep: [], remove: () => true };
		await harness.loop.handleText({ text: '/queue resume', fromUserId: 'user-1', messageId: 'm-resume' });
		await harness.flush();
		assert.equal(harness.loop.paused.has('session-1'), false);
	} finally {
		harness.dispose();
	}
});

test('a cancelled task never delivers its partial output as an answer', async () => {
	const harness = makeLoop({ binding: { sessionId: 'session-1' } });
	try {
		harness.running.status = 'running';
		harness.running.cancel = () => {};
		harness.running.inbox = { nextTurn: [], nextStep: [], remove: () => true };
		await harness.loop.submitTask('长任务', { fromUserId: 'user-1', messageId: 'm-long' });
		harness.loop.onInboxClaimed({ id: 'weixin-m-long' }, 5);
		harness.loop.onAgentFrame({ session: { id: 'session-1' } }, { type: 'chunk', turn: 5, chunk: { type: 'text-delta', text: '说了一半' } });
		await harness.flush();
		harness.sent.length = 0;
		await harness.loop.handleText({ text: '/stop', fromUserId: 'user-1', messageId: 'm-stop2' });
		await harness.flush();
		assert.equal(harness.loop.trackers.size, 0, 'the cancelled task is retired');
		assert.equal(harness.sent.some((text) => text.includes('不再发送')), true);
		assert.equal(harness.sent.some((text) => text.includes('说了一半')), false, 'partial output must not be delivered later');
		/* The turn boundary that follows the abort must not resurrect the answer. */
		harness.loop.onSessionEvent({ id: 'session-1' }, { type: 'turn/end', data: { turn: 5 } });
		await harness.flush();
		assert.equal(harness.sent.some((text) => text.includes('说了一半')), false);
		assert.equal(harness.events.some((event) => event.kind === 'cancelled-by-user'), true);
	} finally {
		harness.dispose();
	}
});

test('a queued task keeps its tracker across a stop and answers after resume', async () => {
	const harness = makeLoop({ binding: { sessionId: 'session-1' } });
	try {
		harness.running.status = 'running';
		harness.running.cancel = () => {};
		harness.running.inbox = { nextTurn: [{ id: 'weixin-m-queued', content: [] }], nextStep: [], remove: () => true };
		await harness.loop.submitTask('排队中的任务', { fromUserId: 'user-1', messageId: 'm-queued' });
		await harness.flush();
		assert.equal(harness.loop.trackers.has('weixin-m-queued'), true);
		await harness.loop.handleText({ text: '/stop', fromUserId: 'user-1', messageId: 'm-stop-queued' });
		await harness.flush();
		assert.equal(harness.loop.trackers.has('weixin-m-queued'), true, 'a task that never ran must keep its tracker');
		assert.equal(harness.sent.some((text) => text.includes('不再发送')), false, 'nothing was cancelled, so no cancellation notice');
		/* The paused queue is resumed and the queued task finally runs. */
		harness.loop.paused.delete('session-1');
		harness.loop.onInboxClaimed({ id: 'weixin-m-queued' }, 6);
		harness.loop.onAgentFrame({ session: { id: 'session-1' } }, { type: 'chunk', turn: 6, chunk: { type: 'text-delta', text: '排队任务的答案' } });
		harness.loop.onSessionEvent({ id: 'session-1' }, { type: 'turn/end', data: { turn: 6 } });
		await harness.flush();
		assert.equal(harness.sent.some((text) => text.includes('排队任务的答案')), true, 'the queued task still reports its result');
	} finally {
		harness.dispose();
	}
});

test('removing a queued task retires its tracker instead of leaving it to time out', async () => {
	const harness = makeLoop({ binding: { sessionId: 'session-1' } });
	try {
		const inboxItems = [{ id: 'weixin-m-remove', content: [{ type: 'text', text: '待删除' }] }];
		harness.agents.get = () => ({
			status: 'idle',
			followup: () => {},
			inbox: {
				get nextTurn() { return inboxItems; },
				get nextStep() { return []; },
				remove: (id) => {
					const at = inboxItems.findIndex((message) => message.id === id);
					if (at < 0) return false;
					inboxItems.splice(at, 1);
					return true;
				},
			},
			cancel: () => {},
			wakeDriver: () => {},
		});
		await harness.loop.submitTask('待删除', { fromUserId: 'user-1', messageId: 'm-remove' });
		await harness.flush();
		assert.equal(harness.loop.trackers.has('weixin-m-remove'), true);
		await harness.loop.handleText({ text: '/queue remove weixin-m-remove', fromUserId: 'user-1', messageId: 'm-remove-cmd' });
		await harness.flush();
		assert.equal(harness.loop.trackers.size, 0, 'a removed task must not stay tracked');
		assert.equal(harness.events.some((event) => event.kind === 'removed-from-queue'), true);
		assert.match(harness.sent.at(-1), /已删除，剩余待执行 0 项/);
		/* A boundary that arrives later must not produce an answer for it. */
		harness.loop.onSessionEvent({ id: 'session-1' }, { type: 'turn/end', data: { turn: 9 } });
		await harness.flush();
		assert.equal(harness.events.some((event) => event.kind === 'settled'), false);
	} finally {
		harness.dispose();
	}
});

test('a due schedule fires into its bound session with a prefixed notification', async () => {
	const harness = makeLoop({ binding: { sessionId: 'session-1', cwd: '' } });
	try {
		const now = harness.loop.now();
		storage.writeSchedules(harness.root, {
			nextId: 2,
			entries: [{
				id: 'sched-1', peer: 'user-1', sessionId: 'session-1', cwd: '', text: '每日构建',
				kind: 'once', at: now, everyMs: 0, nextAt: now, timeZone: '本地时区', createdAt: now,
				sequence: 0, runs: 0, missed: 0, lastOutcome: '', lastRunAt: 0,
			}],
		});
		const result = await harness.loop.fireDueSchedules();
		await harness.flush();
		assert.deepEqual(result, { fired: 1, missed: 0, held: 0 });
		assert.equal(harness.submitted.length, 1);
		assert.equal(harness.submitted[0].id, 'sched-1#0');
		assert.equal(harness.submitted[0].content[0].text, '每日构建');
		const entry = storage.readSchedules(harness.root).entries[0];
		assert.equal(entry.runs, 1);
		assert.equal(entry.nextAt, 0, 'a one-shot entry is finished');
		/* The reply that follows identifies which schedule produced it. */
		harness.loop.onInboxClaimed({ id: 'sched-1#0' }, 4);
		harness.loop.onAgentFrame({ session: { id: 'session-1' } }, { type: 'chunk', turn: 4, chunk: { type: 'text-delta', text: '构建通过' } });
		harness.loop.onSessionEvent({ id: 'session-1' }, { type: 'turn/end', data: { turn: 4 } });
		await harness.flush();
		assert.equal(harness.sent.some((text) => text.startsWith('【定时任务 sched-1】📄') && text.includes('构建通过')), true);
	} finally {
		harness.dispose();
	}
});

test('another peer schedule is neither run nor counted as missed', async () => {
	const harness = makeLoop({ binding: { sessionId: 'session-1', peer: 'user-1' } });
	try {
		const now = harness.loop.now();
		storage.writeSchedules(harness.root, {
			nextId: 3,
			entries: [
				{
					id: 'sched-mine', peer: 'user-1', sessionId: 'session-1', cwd: '', text: '我的任务',
					kind: 'once', at: now, everyMs: 0, nextAt: now, timeZone: '时区', createdAt: now,
					sequence: 0, runs: 0, missed: 0, lastOutcome: '', lastRunAt: 0,
				},
				{
					id: 'sched-theirs', peer: 'user-2', sessionId: 'session-9', cwd: '', text: '别人的任务',
					kind: 'once', at: 0, everyMs: 0, nextAt: 1, timeZone: '时区', createdAt: 0,
					sequence: 0, runs: 0, missed: 0, lastOutcome: '', lastRunAt: 0,
				},
			],
		});
		await harness.loop.fireDueSchedules();
		await harness.flush();
		const entries = storage.readSchedules(harness.root).entries;
		const theirs = entries.find((entry) => entry.id === 'sched-theirs');
		assert.equal(theirs.missed, 0, 'another account\'s missed slot is not this connection\'s business');
		assert.equal(theirs.lastOutcome, '', 'its state is left untouched');
		assert.equal(harness.submitted.length, 1, 'only this peer\'s schedule ran');
		assert.equal(harness.submitted[0].id, 'sched-mine#0');
	} finally {
		harness.dispose();
	}
});

test('logging an account out removes that account\'s schedules', async () => {
	const harness = makeLoop({ binding: { sessionId: 'session-1' } });
	try {
		const now = harness.loop.now();
		storage.writeSchedules(harness.root, {
			nextId: 3,
			entries: [
				{ id: 'sched-a', peer: 'user-1', sessionId: 'session-1', cwd: '', text: 'a', kind: 'once', at: now, everyMs: 0, nextAt: now, timeZone: 't', createdAt: now, sequence: 0, runs: 0, missed: 0, lastOutcome: '', lastRunAt: 0 },
				{ id: 'sched-b', peer: 'user-2', sessionId: 'session-2', cwd: '', text: 'b', kind: 'once', at: now, everyMs: 0, nextAt: now, timeZone: 't', createdAt: now, sequence: 0, runs: 0, missed: 0, lastOutcome: '', lastRunAt: 0 },
			],
		});
		assert.equal(harness.loop.dropSchedulesFor('user-1'), 1);
		assert.deepEqual(storage.readSchedules(harness.root).entries.map((entry) => entry.id), ['sched-b']);
		assert.equal(harness.loop.dropSchedulesFor('user-1'), 0, 'idempotent');
	} finally {
		harness.dispose();
	}
});

test('a schedule missed while the service was down is recorded, never run late', async () => {
	const harness = makeLoop({ binding: { sessionId: 'session-1' } });
	try {
		let clock = 0;
		harness.loop.now = () => clock;
		storage.writeSchedules(harness.root, {
			nextId: 2,
			entries: [{
				id: 'sched-2', peer: 'user-1', sessionId: 'session-1', cwd: '', text: '夜间任务',
				kind: 'once', at: 0, everyMs: 0, nextAt: 1000, timeZone: '本地时区', createdAt: 0,
				sequence: 0, runs: 0, missed: 0, lastOutcome: '', lastRunAt: 0,
			}],
		});
		clock = 3_600_000;
		const result = await harness.loop.fireDueSchedules();
		await harness.flush();
		assert.deepEqual(result, { fired: 0, missed: 1, held: 0 });
		assert.deepEqual(harness.submitted, [], 'a missed schedule must not be executed late');
		const entry = storage.readSchedules(harness.root).entries[0];
		assert.equal(entry.missed, 1);
		assert.equal(entry.lastOutcome, 'missed');
		assert.equal(entry.runs, 0);
	} finally {
		harness.dispose();
	}
});

test('a schedule whose binding changed is marked failed and never re-routed', async () => {
	const harness = makeLoop({ binding: { sessionId: 'session-other' } });
	try {
		const now = harness.loop.now();
		storage.writeSchedules(harness.root, {
			nextId: 2,
			entries: [{
				id: 'sched-3', peer: 'user-1', sessionId: 'session-1', cwd: '', text: '任务',
				kind: 'once', at: now, everyMs: 0, nextAt: now, timeZone: '本地时区', createdAt: now,
				sequence: 0, runs: 0, missed: 0, lastOutcome: '', lastRunAt: 0,
			}],
		});
		const result = await harness.loop.fireDueSchedules();
		await harness.flush();
		assert.deepEqual(result, { fired: 0, missed: 0, held: 0 });
		assert.deepEqual(harness.submitted, []);
		assert.equal(storage.readSchedules(harness.root).entries[0].lastOutcome, 'failed');
		assert.match(harness.sent[0], /绑定会话已变更/);
	} finally {
		harness.dispose();
	}
});

test('a schedule with an unusable directory is marked failed', async () => {
	const harness = makeLoop({ binding: { sessionId: 'session-1', cwd: 'C:\\gone' } });
	try {
		const now = harness.loop.now();
		storage.writeSchedules(harness.root, {
			nextId: 2,
			entries: [{
				id: 'sched-4', peer: 'user-1', sessionId: 'session-1', cwd: join(tmpdir(), 'definitely-missing-dir-xyz'), text: '任务',
				kind: 'once', at: now, everyMs: 0, nextAt: now, timeZone: '本地时区', createdAt: now,
				sequence: 0, runs: 0, missed: 0, lastOutcome: '', lastRunAt: 0,
			}],
		});
		await harness.loop.fireDueSchedules();
		await harness.flush();
		assert.deepEqual(harness.submitted, []);
		assert.match(harness.sent[0], /工作目录不可用/);
		assert.equal(storage.readSchedules(harness.root).entries[0].lastOutcome, 'failed');
	} finally {
		harness.dispose();
	}
});

test('a periodic schedule fired punctually keeps its anchor and counts no miss', async () => {
	const harness = makeLoop({ binding: { sessionId: 'session-1' } });
	try {
		const now = harness.loop.now();
		storage.writeSchedules(harness.root, {
			nextId: 2,
			entries: [{
				id: 'sched-5', peer: 'user-1', sessionId: 'session-1', cwd: '', text: '每小时同步',
				kind: 'every', at: now, everyMs: 3_600_000, nextAt: now, timeZone: '本地时区', createdAt: now,
				sequence: 0, runs: 0, missed: 0, lastOutcome: '', lastRunAt: 0,
			}],
		});
		await harness.loop.fireDueSchedules();
		await harness.flush();
		const entry = storage.readSchedules(harness.root).entries[0];
		assert.equal(entry.runs, 1);
		assert.equal(entry.missed, 0);
		assert.equal(entry.nextAt, now + 3_600_000);
	} finally {
		harness.dispose();
	}
});

test('the schedule store is not re-read on every tick', async () => {
	const harness = makeLoop({ binding: { sessionId: 'session-1' } });
	try {
		const first = await harness.loop.fireDueSchedules();
		const second = await harness.loop.fireDueSchedules();
		assert.deepEqual(first, { fired: 0, missed: 0, held: 0 });
		assert.deepEqual(second, { fired: 0, missed: 0, held: 0 });
		assert.equal(harness.loop.nextScheduleCheckAt > harness.loop.now(), true);
	} finally {
		harness.dispose();
	}
});

test('a due schedule is held while the session is paused, then runs after resume', async () => {
	const harness = makeLoop({ binding: { sessionId: 'session-1' } });
	try {
		const now = harness.loop.now();
		storage.writeSchedules(harness.root, {
			nextId: 2,
			entries: [{
				id: 'sched-9', peer: 'user-1', sessionId: 'session-1', cwd: '', text: '定时任务',
				kind: 'once', at: now, everyMs: 0, nextAt: now, timeZone: '本地时区', createdAt: now,
				sequence: 0, runs: 0, missed: 0, lastOutcome: '', lastRunAt: 0,
			}],
		});
		harness.loop.paused.add('session-1');
		const held = await harness.loop.fireDueSchedules();
		await harness.flush();
		assert.deepEqual(held, { fired: 0, missed: 0, held: 1 });
		assert.deepEqual(harness.submitted, [], 'a paused session must not be woken by scheduled work');
		const untouched = storage.readSchedules(harness.root).entries[0];
		assert.equal(untouched.nextAt, now, 'a held occurrence keeps its slot inside the grace window');
		assert.equal(untouched.missed, 0);
		assert.equal(harness.events.some((event) => event.kind === 'schedule-held'), true);
		/* Resume, and the same occurrence still runs because it was not discarded. */
		harness.loop.paused.delete('session-1');
		harness.loop.nextScheduleCheckAt = 0;
		const fired = await harness.loop.fireDueSchedules();
		await harness.flush();
		assert.deepEqual(fired, { fired: 1, missed: 0, held: 0 });
		assert.equal(harness.submitted.length, 1);
	} finally {
		harness.dispose();
	}
});

test('one failing message does not end the batch or the loop', async () => {
	const harness = makeLoop({
		messages: [{ message_id: 'm-bad', from_user_id: 'user-1', message_type: 1, create_time_ms: 1000, item_list: [{ type: 1, text_item: { text: '/cwd' } }] }, { message_id: 'm-good', from_user_id: 'user-1', message_type: 1, create_time_ms: 1000, item_list: [{ type: 1, text_item: { text: '/help' } }] }],
		binding: { sessionId: 'session-1' },
	});
	try {
		/* Make the first message's handling throw, then let the second proceed. */
		const realRead = storage.readBindings;
		let calls = 0;
		harness.loop.storage = {
			...storage,
			readBindings: (root) => {
				calls += 1;
				if (calls === 1) throw new Error('storage unavailable');
				return realRead(root);
			},
		};
		await harness.loop.tick();
		await harness.flush();
		assert.equal(harness.events.some((event) => event.kind === 'message-failed'), true);
		assert.match(harness.sent[0], /处理这条消息时出错：storage unavailable/);
		assert.equal(harness.sent.some((text) => text.includes('可用命令')), true, 'the next message in the batch still runs');
		const state = storage.readChannelState(harness.root);
		assert.deepEqual(state.seenIds.sort(), ['m-bad', 'm-good'], 'a failed message is still recorded so it is not redelivered forever');
	} finally {
		harness.dispose();
	}
});

test('an unexpected tick failure backs off instead of ending receiving', async () => {
	const harness = makeLoop({ messages: [], cursor: 'c' });
	try {
		let calls = 0;
		const realRead = storage.readChannelState;
		harness.loop.storage = {
			...storage,
			readChannelState: (root) => realRead(root),
		};
		harness.loop.tick = async () => {
			calls += 1;
			if (calls === 1) throw new Error('transient fault');
			harness.loop.stop('done');
			return 'stopped';
		};
		await harness.loop.run();
		assert.equal(calls, 2, 'the loop retried after the failure');
		assert.equal(harness.events.some((event) => event.kind === 'loop-failed'), true);
		assert.equal(harness.loop.failures, 1);
	} finally {
		harness.dispose();
	}
});

test('the idle wait follows the server suggestion inside a bounded band', async () => {
	const waits = [];
	const harness = makeLoop({
		messages: [],
		cursor: 'c',
		transport: { pollUpdates: async () => ({ messages: [], cursor: 'c', stale: false, timedOut: false, suggestedTimeoutMs: 2000 }) },
	});
	try {
		harness.loop.sleep = async (ms) => { waits.push(ms); };
		await harness.loop.tick();
		assert.deepEqual(waits, [2000], 'a server suggestion above the floor is honoured');
		assert.equal(harness.loop.suggestedIdle({ suggestedTimeoutMs: 10 }), 500, 'the floor keeps a hot loop impossible');
		assert.equal(harness.loop.suggestedIdle({ suggestedTimeoutMs: 999999 }), 5000, 'the ceiling bounds a hostile suggestion');
		assert.equal(harness.loop.suggestedIdle({}), 500);
	} finally {
		harness.dispose();
	}
});

test('a submission is marked before the attempt and cleared once accepted', async () => {
	const harness = makeLoop({ binding: { sessionId: 'session-1' } });
	try {
		let observedDuringSubmit;
		harness.running.followup = () => {
			/* The marker must already be durable while the submission is in flight. */
			observedDuringSubmit = storage.readChannelState(harness.root).inflight;
		};
		await harness.loop.submitTask('跑测试', { fromUserId: 'user-1', messageId: 'm-mark' });
		assert.equal(observedDuringSubmit?.requestId, 'weixin-m-mark');
		assert.equal(observedDuringSubmit?.sessionId, 'session-1');
		assert.equal(observedDuringSubmit?.text, '跑测试');
		assert.equal(storage.readChannelState(harness.root).inflight, undefined, 'accepted work clears the marker');
	} finally {
		harness.dispose();
	}
});

test('a submission whose acceptance never happened is reported, never re-run', async () => {
	const harness = makeLoop({ binding: { sessionId: 'session-1' } });
	try {
		/* Simulate a crash between marking and acceptance. */
		harness.loop.markInflight({ messageId: 'weixin-m-lost', requestId: 'weixin-m-lost', sessionId: 'session-1', text: '高权限任务' });
		const reported = await harness.loop.reportUnconfirmed();
		await harness.flush();
		assert.equal(reported, true);
		assert.deepEqual(harness.submitted, [], 'an unconfirmed task must never be submitted again');
		assert.match(harness.sent[0], /未能确认是否已被接受/);
		assert.match(harness.sent[0], /不会被自动重跑/);
		assert.equal(storage.readChannelState(harness.root).inflight.state, 'unconfirmed', 'the record stays visible');
		assert.equal(harness.events.some((event) => event.kind === 'inflight-unconfirmed'), true);
		const again = await harness.loop.reportUnconfirmed();
		assert.equal(again, true, 'it is still reported until the user acts on it');
	} finally {
		harness.dispose();
	}
});

test('a restart with no unconfirmed record reports nothing', async () => {
	const harness = makeLoop({ binding: { sessionId: 'session-1' } });
	try {
		assert.equal(await harness.loop.reportUnconfirmed(), false);
		await harness.flush();
		assert.deepEqual(harness.sent, []);
	} finally {
		harness.dispose();
	}
});

test('a refused submission clears the marker so it is not later reported as unknown', async () => {
	const harness = makeLoop({
		binding: { sessionId: 'session-1' },
		agent: { followup: () => { throw new Error('inbox closed'); } },
	});
	try {
		await harness.loop.submitTask('跑测试', { fromUserId: 'user-1', messageId: 'm-refused' });
		await harness.flush();
		assert.match(harness.sent[0], /任务提交失败/);
		assert.equal(storage.readChannelState(harness.root).inflight, undefined);
		assert.equal(await harness.loop.reportUnconfirmed(), false);
	} finally {
		harness.dispose();
	}
});

test('an undeliverable reply is remembered across a restart', async () => {
	const harness = makeLoop({ binding: { sessionId: 'session-1' } });
	try {
		await harness.loop.submitTask('任务', { fromUserId: 'user-1', messageId: 'm-reply' });
		harness.loop.onInboxClaimed({ id: 'weixin-m-reply' }, 2);
		/* Make the transport fail so the tracker records a delivery error. */
		harness.loop.scheduler.send = async () => { throw new Error('context expired'); };
		harness.loop.onAgentFrame({ session: { id: 'session-1' } }, { type: 'chunk', turn: 2, chunk: { type: 'text-delta', text: '答案' } });
		harness.loop.onSessionEvent({ id: 'session-1' }, { type: 'turn/end', data: { turn: 2 } });
		await harness.flush();
		assert.equal(storage.readChannelState(harness.root).lastReplyError, 'context expired');
	} finally {
		harness.dispose();
	}
});

test('stopping clears the typing indicator once a task was running', async () => {
	const harness = makeLoop({ binding: { sessionId: 'session-1' } });
	try {
		await harness.loop.submitTask('任务', { fromUserId: 'user-1', messageId: 'm-stop-typing' });
		await harness.flush();
		harness.typingCalls.length = 0;
		harness.loop.stop('plugin-unload');
		await harness.flush();
		assert.equal(harness.typingCalls.includes(2), true);
	} finally {
		harness.dispose();
	}
});
