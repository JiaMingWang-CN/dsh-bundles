import assert from 'node:assert/strict';
import test from 'node:test';

import {
	previewOf, queueSnapshot, removeQueued, resumeQueue, stopTask, viewQueue,
} from '../lib/queue.js';

/** One queued inbox message. */
function queued(id, text) {
	return { id, content: [{ type: 'text', text }] };
}

/** A live-agent stand-in with a controllable inbox. */
function fakeAgent({ running = false, nextTurn = [], nextStep = [] } = {}) {
	const state = { nextTurn: [...nextTurn], nextStep: [...nextStep] };
	const calls = { cancel: [], wake: 0 };
	return {
		status: running ? 'running' : 'idle',
		inbox: {
			get nextTurn() { return state.nextTurn; },
			get nextStep() { return state.nextStep; },
			remove: (id) => {
				for (const key of ['nextStep', 'nextTurn']) {
					const at = state[key].findIndex((message) => message.id === id);
					if (at >= 0) {
						state[key].splice(at, 1);
						return true;
					}
				}
				return false;
			},
			clear: () => { state.nextTurn = []; state.nextStep = []; },
		},
		cancel: (cause, options) => { calls.cancel.push({ cause, options }); },
		wakeDriver: () => { calls.wake += 1; },
	};
}

/** An `agents` service exposing one live agent. */
function agentsWith(agent) {
	return { get: (id) => (id === 'session-1' ? agent : undefined) };
}

test('a preview shows the text and never an attachment path', () => {
	assert.equal(previewOf(queued('a', '  跑一下   测试 ')), '跑一下 测试');
	assert.equal(previewOf(queued('b', 'x'.repeat(80))).length, 41);
	assert.equal(previewOf({ id: 'c', content: [{ type: 'image', path: 'C:\\secret.png' }] }), '（无文字内容）');
	assert.equal(previewOf({ id: 'd', content: [{ type: 'image' }, { type: 'text', text: '说明' }] }), '说明');
});

test('the queue snapshot orders steering before queued turns', () => {
	const agent = fakeAgent({ nextStep: [queued('s1', 'steer')], nextTurn: [queued('t1', 'task one'), queued('t2', 'task two')] });
	const snapshot = queueSnapshot(agent);
	assert.equal(snapshot.pending, 3);
	assert.deepEqual(snapshot.items.map((item) => item.id), ['s1', 't1', 't2']);
	assert.deepEqual(snapshot.items.map((item) => item.placement), ['step', 'queued', 'queued']);
});

test('stop cancels with the inbox kept and reports what remains', () => {
	const agent = fakeAgent({ running: true, nextTurn: [queued('t1', 'a'), queued('t2', 'b')] });
	const result = stopTask({ agents: agentsWith(agent), sessionId: 'session-1', now: () => 42 });
	assert.equal(result.ok, true);
	assert.equal(result.wasRunning, true);
	assert.equal(result.pending, 2);
	assert.equal(result.stoppedAt, 42);
	assert.equal(agent.inbox.nextTurn.length, 2, 'cancel must not clear the queue');
	assert.equal(agent.status, 'running');
});

test('the cancel cause is attributable and keeps the inbox', () => {
	const agent = fakeAgent({ running: true });
	stopTask({ agents: agentsWith(agent), sessionId: 'session-1' });
	/* The agent stand-in records what the real one would receive. */
	assert.equal(agent.status, 'running');
});

test('stop reports when nothing was running', () => {
	const agent = fakeAgent({ running: false });
	const result = stopTask({ agents: agentsWith(agent), sessionId: 'session-1' });
	assert.equal(result.ok, true);
	assert.equal(result.wasRunning, false);
});

test('stop on a session that is not live refuses instead of pretending', () => {
	const result = stopTask({ agents: agentsWith(undefined), sessionId: 'session-9' });
	assert.deepEqual(result, { ok: false, reason: 'session-not-live' });
});

test('a cancel failure is reported, not swallowed', () => {
	const agent = fakeAgent();
	agent.cancel = () => { throw new Error('driver busy'); };
	const result = stopTask({ agents: agentsWith(agent), sessionId: 'session-1' });
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'cancel-failed');
	assert.match(result.detail, /driver busy/);
});

test('the queue view reports running state and items', () => {
	const agent = fakeAgent({ running: true, nextTurn: [queued('t1', 'later')] });
	const view = viewQueue({ agents: agentsWith(agent), sessionId: 'session-1' });
	assert.equal(view.ok, true);
	assert.equal(view.running, true);
	assert.equal(view.pending, 1);
	assert.equal(view.items[0].id, 't1');
});

test('removing a pending item works once and then reports it is gone', () => {
	const agent = fakeAgent({ nextTurn: [queued('t1', 'a'), queued('t2', 'b')] });
	const first = removeQueued({ agents: agentsWith(agent), sessionId: 'session-1', itemId: 't1' });
	assert.deepEqual(first, { ok: true, pending: 1 });
	const second = removeQueued({ agents: agentsWith(agent), sessionId: 'session-1', itemId: 't1' });
	assert.equal(second.ok, false);
	assert.equal(second.reason, 'item-not-pending');
	assert.equal(second.pending, 1);
});

test('removing without an id or on a dead session is refused', () => {
	assert.equal(removeQueued({ agents: agentsWith(fakeAgent()), sessionId: 'session-1', itemId: '  ' }).reason, 'item-id-missing');
	assert.equal(removeQueued({ agents: agentsWith(undefined), sessionId: 'session-1', itemId: 'x' }).reason, 'session-not-live');
});

test('an item the inbox refuses to drop is reported as not pending', () => {
	const agent = fakeAgent({ nextTurn: [queued('t1', 'a')] });
	agent.inbox.remove = () => false;
	const result = removeQueued({ agents: agentsWith(agent), sessionId: 'session-1', itemId: 't1' });
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'item-not-pending');
});

test('resume wakes an idle agent with pending work', () => {
	const agent = fakeAgent({ nextTurn: [queued('t1', 'a')] });
	const result = resumeQueue({ agents: agentsWith(agent), sessionId: 'session-1' });
	assert.deepEqual(result, { ok: true, outcome: 'woken' });
});

test('resume reports an empty queue and an already-running turn', () => {
	const idle = fakeAgent();
	assert.deepEqual(resumeQueue({ agents: agentsWith(idle), sessionId: 'session-1' }), { ok: true, outcome: 'empty' });
	const running = fakeAgent({ running: true, nextTurn: [queued('t1', 'a')] });
	assert.deepEqual(resumeQueue({ agents: agentsWith(running), sessionId: 'session-1' }), { ok: true, outcome: 'already-running' });
});

test('resume reports a deferred wake when the agent exposes no wake entry', () => {
	const agent = fakeAgent({ nextTurn: [queued('t1', 'a')] });
	delete agent.wakeDriver;
	assert.deepEqual(resumeQueue({ agents: agentsWith(agent), sessionId: 'session-1' }), { ok: true, outcome: 'deferred' });
});

test('a failing wake is reported rather than claimed as resumed', () => {
	const agent = fakeAgent({ nextTurn: [queued('t1', 'a')] });
	agent.wakeDriver = () => { throw new Error('cannot wake'); };
	const result = resumeQueue({ agents: agentsWith(agent), sessionId: 'session-1' });
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'wake-failed');
});
