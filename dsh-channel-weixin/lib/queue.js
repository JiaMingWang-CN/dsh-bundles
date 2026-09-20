/**
 * Task control: stop the running turn, inspect the pending queue, remove one
 * queued item, and resume.
 *
 * The queue itself stays where the harness put it — the agent's durable inbox —
 * so this module never keeps a second queue that could disagree with the one a
 * browser user sees. What it adds is the *pause* the plan requires:
 *
 * `agent.cancel(cause, { keepInbox: true })` aborts the running turn and, because
 * the abort propagates out of the driver loop, leaves queued items pending
 * without starting the next one. Nothing runs again until something wakes the
 * agent, so "stop then continue explicitly" is the harness's own behaviour
 * rather than a policy layered on top of it.
 *
 * Removal and inspection use the inbox's public operations, and every operation
 * reports what actually happened instead of assuming success.
 */

/** Cause recorded on a cancel that came from WeChat, so the log is attributable. */
const WEIXIN_CANCEL_CAUSE = { kind: 'weixin-user', reason: 'stop command' };

/** Characters of a queued item shown in a chat listing. */
const PREVIEW_CHARS = 40;

/**
 * The text of one queued message, bounded for display.
 *
 * Only text blocks are previewed: a queued message carrying an attachment shows
 * its text and never a path or a payload.
 * @param message - one inbox message.
 * @returns a single-line preview.
 */
function previewOf(message) {
	const blocks = Array.isArray(message?.content) ? message.content : [];
	for (const block of blocks) {
		if (block?.type !== 'text' || typeof block.text !== 'string') continue;
		const line = block.text.replace(/\s+/g, ' ').trim();
		if (line === '') continue;
		return line.length <= PREVIEW_CHARS ? line : line.slice(0, PREVIEW_CHARS) + '…';
	}
	return '（无文字内容）';
}

/** The live agent for one session, or undefined. */
function liveAgent(agents, sessionId) {
	if (agents === undefined || typeof agents.get !== 'function') return undefined;
	return agents.get(sessionId);
}

/**
 * The pending queue as the chat listing shows it.
 * @param agent - the live agent (or undefined).
 * @returns `{ pending, items }` with items in execution order.
 */
function queueSnapshot(agent) {
	if (agent === undefined || agent.inbox === undefined) return { pending: 0, items: [] };
	const nextTurn = Array.isArray(agent.inbox.nextTurn) ? agent.inbox.nextTurn : [];
	const nextStep = Array.isArray(agent.inbox.nextStep) ? agent.inbox.nextStep : [];
	const items = [
		...nextStep.map((message) => ({ id: String(message?.id ?? ''), placement: 'step', preview: previewOf(message) })),
		...nextTurn.map((message) => ({ id: String(message?.id ?? ''), placement: 'queued', preview: previewOf(message) })),
	];
	return { pending: items.length, items };
}

/**
 * Stop the running turn, keeping the queue.
 * @param options - the `agents` service, the session, and an injected timestamp.
 * @returns a report of what was stopped and what remains queued.
 */
function stopTask({ agents, sessionId, now = Date.now }) {
	const agent = liveAgent(agents, sessionId);
	if (agent === undefined) return { ok: false, reason: 'session-not-live' };
	const wasRunning = agent.status === 'running';
	const before = queueSnapshot(agent);
	try {
		agent.cancel(WEIXIN_CANCEL_CAUSE, { keepInbox: true });
	} catch (error) {
		return { ok: false, reason: 'cancel-failed', detail: String(error?.message ?? error) };
	}
	return {
		ok: true,
		wasRunning,
		pending: before.pending,
		stoppedAt: now(),
		/* Cancelling is a request: side effects already performed are not undone. */
		note: 'cancel-requested',
	};
}

/** List the pending queue, whether or not a turn is running. */
function viewQueue({ agents, sessionId }) {
	const agent = liveAgent(agents, sessionId);
	if (agent === undefined) return { ok: false, reason: 'session-not-live' };
	const snapshot = queueSnapshot(agent);
	return { ok: true, running: agent.status === 'running', ...snapshot };
}

/**
 * Remove one still-pending item by its stable id.
 * @param options - services, session, and the item id the user typed.
 * @returns whether the item was still pending and got removed.
 */
function removeQueued({ agents, sessionId, itemId }) {
	const agent = liveAgent(agents, sessionId);
	if (agent === undefined) return { ok: false, reason: 'session-not-live' };
	const wanted = String(itemId ?? '').trim();
	if (wanted === '') return { ok: false, reason: 'item-id-missing' };
	const snapshot = queueSnapshot(agent);
	if (!snapshot.items.some((item) => item.id === wanted)) {
		/* Either it already ran, or it never existed: both are "not pending now". */
		return { ok: false, reason: 'item-not-pending', pending: snapshot.pending };
	}
	try {
		const removed = agent.inbox.remove(wanted);
		if (removed !== true) return { ok: false, reason: 'item-not-pending', pending: snapshot.pending };
	} catch (error) {
		return { ok: false, reason: 'remove-failed', detail: String(error?.message ?? error) };
	}
	return { ok: true, pending: snapshot.pending - 1 };
}

/**
 * Resume a paused queue.
 *
 * After a stop the harness leaves queued items pending and no driver running, so
 * resuming means waking the agent. `wakeDriver` is the agent's own entry point
 * for that; when a future version stops exposing it, the queue still continues
 * as soon as any other input wakes the agent, and the reply says so rather than
 * claiming a resume that did not happen.
 * @param options - services and session.
 * @returns `{ ok, outcome }` where outcome is `woken`, `already-running`, `empty`, or `deferred`.
 */
function resumeQueue({ agents, sessionId }) {
	const agent = liveAgent(agents, sessionId);
	if (agent === undefined) return { ok: false, reason: 'session-not-live' };
	const snapshot = queueSnapshot(agent);
	if (snapshot.pending === 0) return { ok: true, outcome: 'empty' };
	if (agent.status === 'running') return { ok: true, outcome: 'already-running' };
	if (typeof agent.wakeDriver !== 'function') return { ok: true, outcome: 'deferred' };
	try {
		agent.wakeDriver();
	} catch (error) {
		return { ok: false, reason: 'wake-failed', detail: String(error?.message ?? error) };
	}
	return { ok: true, outcome: 'woken' };
}

export {
	PREVIEW_CHARS, WEIXIN_CANCEL_CAUSE, liveAgent, previewOf, queueSnapshot,
	removeQueued, resumeQueue, stopTask, viewQueue,
};
