/**
 * The channel loop: inbound polling, command dispatch, task submission, and
 * reply delivery.
 *
 * Rules this module owns, all from the plan:
 *
 * - One WeChat account, and only its bound user may do anything. Every other
 *   sender is dropped before a session or a model is involved.
 * - A task needs a bound session. Without one the reply asks for `/new` or
 *   `/use`; the loop never silently creates a session in an arbitrary place.
 * - The cursor and the handled-message record move in one atomic write, and the
 *   record is written before the cursor for that message is published, so a
 *   crash can re-deliver at worst and never skip.
 * - A stale credential stops the loop and is reported, instead of retrying a
 *   dead token at full speed.
 * - Failures back off (short, then long), and a stopped loop owns nothing: the
 *   caller disposes it with the plugin fiber.
 */

import { DedupeWindow, classifyInbound } from './inbound.js';
import { handleInbound } from './dispatch.js';
import { SendScheduler, segmentText } from './reply.js';
import { TaskTracker, buildRequestMessage } from './task.js';
import { validateDirectory } from './sessions.js';
import { applyOutcome, classifyDue, occurrenceId } from './schedule.js';

/** Short retry delay after a transient failure. */
const RETRY_SHORT_MS = 2000;

/** Long retry delay once three consecutive failures have happened. */
const RETRY_LONG_MS = 30_000;

/** Consecutive failures before the loop slows down. */
const FAILURES_BEFORE_BACKOFF = 3;

/**
 * Idle delay after a poll that returned immediately with nothing.
 *
 * A real `getupdates` call is held open by the server, so this path is rare —
 * but if a server (or a proxy) answers instantly, re-polling in a tight loop
 * would spin the process and starve every other task on it.
 */
const IDLE_DELAY_MS = 500;

/** Upper bound for the idle wait, so a hostile suggestion cannot stall receiving. */
const IDLE_MAX_MS = 5000;

/** Typing tickets are cached per peer for at most this long (the reference assumes hours). */
const TYPING_TICKET_TTL_MS = 6 * 60 * 60_000;

/** Reply shown when a task arrives with no bound session. */
const NO_BINDING_REPLY = '尚未绑定 DSH 会话。用 /new <绝对目录> 新建，或 /sessions 查看后 /use <短ID> 切换。';

/** Reply shown when a task arrives while the session's queue is paused by `/stop`. */
const PAUSED_REPLY = '该会话的队列处于暂停状态（由 /stop 暂停）。用 /queue 查看待执行项、/queue resume 继续；本次消息未提交。';

/** Line prepended to a reply when the task could not even be submitted. */
const SUBMIT_FAILED_PREFIX = '任务提交失败：';

/** Report sent once for a submission whose acceptance was never confirmed. */
const UNCONFIRMED_REPLY = '上一次连接中断时有一条任务未能确认是否已被接受。为避免重复执行高权限任务，它不会被自动重跑；请检查绑定会话中的实际执行情况，必要时手动重新发送。';

/** How often the schedule store is checked; the grace window is far longer. */
const SCHEDULE_CHECK_INTERVAL_MS = 10_000;

/**
 * The channel loop for one account.
 *
 * Everything external is injected: the protocol calls, the DSH services, the
 * storage helpers, the clock, and the sleep used by backoff. That keeps the
 * whole loop testable without a socket or a harness.
 */
class ChannelLoop {
	/**
	 * @param options - account, storage root, services, transport, and clock.
	 */
	constructor({
		account,
		root,
		agents,
		permissionPresets,
		persistence,
		storage,
		transport,
		version,
		now = Date.now,
		sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		scheduler,
		onStatus = () => {},
		minIntervalMs,
		services = {},
		discardInitialBacklog = true,
	}) {
		this.account = account;
		this.root = root;
		this.agents = agents;
		this.permissionPresets = permissionPresets;
		this.persistence = persistence;
		this.storage = storage;
		this.transport = transport;
		this.version = version;
		this.services = services;
		this.now = now;
		/* The first poll establishes a server-cursor baseline. Wall-clock comparison
		 * is unsafe because the DSH host and WeChat server clocks may differ. */
		this.baselinePending = discardInitialBacklog;
		this.sleep = sleep;
		this.onStatus = onStatus;
		this.state = this.storage.readChannelState(root);
		this.seen = DedupeWindow.from(this.state.seenIds);
		this.cursor = this.state.cursor;
		/** Unconfirmed submission inherited from a previous run, if any. */
		this.inflight = this.state.inflight;
		/** Last reply-delivery failure, kept visible across restarts. */
		this.lastReplyError = this.state.lastReplyError ?? '';
		this.trackers = new Map();
		this.failures = 0;
		this.stopped = false;
		this.stale = false;
		this.tickets = new Map();
		/** Sessions whose queue was paused by `/stop`; new tasks are held back. */
		this.paused = new Set();
		/** Throttle for reading the schedule store. */
		this.nextScheduleCheckAt = 0;
		/** Context token of the most recent inbound message; replies reuse it. */
		this.contextToken = '';
		this.scheduler = scheduler ?? new SendScheduler({
			send: (text, _kind, delivery = {}) => this.transport.sendText({
				token: this.account.botToken,
				version: this.version,
				toUserId: this.account.userId,
				text,
				contextToken: delivery.contextToken ?? this.contextToken,
				...(typeof delivery.runId === 'string' && delivery.runId !== '' ? { runId: delivery.runId } : {}),
			}),
			...(minIntervalMs === undefined ? {} : { minIntervalMs }),
			now,
			sleep,
		});
	}

	/** Stop accepting new work; the caller owns disposal of the plugin fiber. */
	stop(reason = 'stopped') {
		this.stopped = true;
		this.reason = reason;
		for (const tracker of this.trackers.values()) tracker.abandon(reason);
		/* Best-effort: clear the typing indicator we may have left on. */
		if (this.trackers.size > 0) this.typing(2).catch(() => {});
		this.trackers.clear();
	}

	/**
	 * Persist the handled-message record and the advanced cursor together.
	 *
	 * The message id is added first and both halves land in one document, which
	 * is the plan's requirement that a crash cannot advance the cursor past an
	 * unrecorded message.
	 * @param messageId - the message that was handled.
	 * @param cursor - the cursor to publish, when this batch produced one.
	 */
	#remember(messageId, cursor) {
		if (typeof messageId === 'string' && messageId !== '') this.seen.add(messageId);
		if (typeof cursor === 'string') this.cursor = cursor;
		this.state = this.storage.writeChannelState(this.root, {
			cursor: this.cursor,
			seenIds: this.seen.toArray(),
			inflight: this.inflight,
			lastReplyError: this.lastReplyError,
		});
	}

	/**
	 * Record a submission before it is attempted.
	 *
	 * The plan's crash window is between "message recorded" and "task accepted".
	 * Marking first means a crash in that window leaves an unconfirmed record,
	 * which the next start reports instead of executing again: the safe direction
	 * for a task that runs with full permissions.
	 * @param record - `{ messageId, requestId, sessionId, text }`.
	 */
	markInflight(record) {
		this.inflight = { ...record, at: this.now(), state: 'submitting' };
		this.#remember(undefined, undefined);
	}

	/** Clear the in-flight marker once the harness accepted (or refused) the task. */
	clearInflight() {
		if (this.inflight === undefined) return;
		this.inflight = undefined;
		this.#remember(undefined, undefined);
	}

	/**
	 * Report an unconfirmed submission from a previous run, once.
	 *
	 * Nothing is submitted here: the whole point is that an unknown outcome must
	 * not be retried. The record is marked unconfirmed and kept visible so the
	 * condition survives another crash before the user reads the notice.
	 * @returns whether such a record existed.
	 */
	async reportUnconfirmed() {
		const record = this.inflight;
		if (record === undefined) return false;
		if (record.state === 'submitting') {
			this.inflight = { ...record, state: 'unconfirmed' };
			this.#remember(undefined, undefined);
		}
		await this.reply(UNCONFIRMED_REPLY);
		this.onStatus({ kind: 'inflight-unconfirmed', requestId: record.requestId, sessionId: record.sessionId });
		return true;
	}

	/** Remember the last reply-delivery failure so it stays visible after a restart. */
	noteReplyError(error) {
		if (typeof error !== 'string' || error === '') return;
		this.lastReplyError = error;
		this.#remember(undefined, undefined);
	}

	/** Reply to the bound peer, segmented and rate-limited. */
	async reply(text) {
		for (const segment of segmentText(text)) await this.scheduler.enqueue('body', segment);
	}

	/** One typing indicator for the bound peer, best effort and ticket-cached. */
	async typing(status) {
		try {
			const ticket = await this.#typingTicket();
			if (ticket === '') return;
			await this.transport.sendTyping({
				token: this.account.botToken,
				version: this.version,
				peerUserId: this.account.userId,
				typingTicket: ticket,
				status,
			});
		} catch {
			/* The indicator is cosmetic: never let it disturb the task. */
		}
	}

	/** The cached typing ticket for this peer, refreshed when expired. */
	async #typingTicket() {
		const cached = this.tickets.get(this.account.userId);
		if (cached !== undefined && this.now() - cached.at < TYPING_TICKET_TTL_MS) return cached.ticket;
		const ticket = await this.transport.fetchTypingTicket({
			token: this.account.botToken,
			version: this.version,
			peerUserId: this.account.userId,
			contextToken: this.contextToken,
		});
		/* The reference randomizes the cache lifetime within a day; a fixed, shorter
		 * window is equivalent and easier to reason about. */
		this.tickets.set(this.account.userId, { ticket, at: this.now() });
		return ticket;
	}

	/**
	 * Consume one batch of inbound messages.
	 * @param answer - one `pollUpdates` result.
	 * @returns how many messages were handled.
	 */
	async handleBatch(answer) {
		let handled = 0;
		for (const message of answer.messages) {
			const classified = classifyInbound(message, { boundUserId: this.account.userId, seen: this.seen });
			if (classified.kind !== 'text') continue;
			if (typeof classified.contextToken === 'string') this.contextToken = classified.contextToken;
			handled += 1;
			try {
				await this.handleText(classified);
			} catch (error) {
				/* One bad message must not end the batch, and must not be re-delivered
				 * forever: report it, then record it as handled like any other. */
				const detail = String(error?.message ?? error);
				this.onStatus({ kind: 'message-failed', messageId: classified.messageId, error: detail });
				await this.reply(`处理这条消息时出错：${detail}`).catch(() => {});
			}
			this.#remember(classified.messageId, undefined);
		}
		if (answer.cursor !== this.cursor) this.#remember(undefined, answer.cursor);
		return handled;
	}

	/**
	 * Handle one classified inbound text message: a command, or a task.
	 * @param classified - the classification result.
	 */
	async handleText(classified) {
		const command = await handleInbound({
			text: classified.text,
			peer: classified.fromUserId,
			root: this.root,
			agents: this.agents,
			permissionPresets: this.permissionPresets,
			persistence: this.persistence,
			storage: this.storage,
			now: this.now,
			services: {
				...this.services,
				/* `agents` is already resolved above; the rest arrive lazily so a
				 * deployment without them degrades to "unavailable" replies. */
				agents: this.agents,
			},
		});
		if (command.action === 'ignore') return;
		if (command.action === 'reply') {
			/* `/stop` pauses the session's queue; `/queue resume` lifts it. */
			const binding = this.storage.readBindings(this.root)[classified.fromUserId];
			if (binding !== undefined && command.paused === true) {
				this.paused.add(binding.sessionId);
				await this.#cancelSessionTasks(binding.sessionId);
			}
			if (binding !== undefined && command.resumed === true) this.paused.delete(binding.sessionId);
			if (typeof command.removedItemId === 'string' && command.removedItemId !== '') this.retireRemoved(command.removedItemId);
			await this.reply(command.text);
			return;
		}
		await this.submitTask(command.text, classified);
	}

	/**
	 * Retire the trackers of one session whose running turn was just cancelled.
	 *
	 * Only tasks the harness has already claimed are retired: a task still waiting
	 * in the queue has produced nothing yet, and `/stop` pauses the queue rather
	 * than discarding it, so its tracker must survive to deliver the answer after
	 * an explicit `/queue resume`. Retiring those too would leave the user with
	 * silence for work that really did run.
	 * @param sessionId - the session whose turn was cancelled.
	 * @returns how many running tasks were retired.
	 */
	async #cancelSessionTasks(sessionId) {
		const cancelled = [];
		for (const [requestId, tracker] of this.trackers) {
			if (tracker.sessionId !== sessionId) continue;
			if (tracker.turn === undefined) continue;
			tracker.abandon('stopped-by-user');
			this.trackers.delete(requestId);
			cancelled.push(requestId);
		}
		if (cancelled.length === 0) return 0;
		this.onStatus({ kind: 'cancelled-by-user', requests: cancelled });
		await this.reply('当前任务的后续输出不再发送；已产生的副作用不会回滚。').catch(() => {});
		this.typing(2).catch(() => {});
		return cancelled.length;
	}

	/**
	 * Retire the tracker of one task the user removed from the queue.
	 *
	 * The item will never run, so waiting for its turn would only produce a
	 * timeout notice half an hour later.
	 * @param requestId - the removed inbox message id.
	 * @returns whether a tracker was retired.
	 */
	retireRemoved(requestId) {
		const tracker = this.trackers.get(requestId);
		if (tracker === undefined) return false;
		tracker.abandon('removed-from-queue');
		this.trackers.delete(requestId);
		this.onStatus({ kind: 'removed-from-queue', requestId });
		return true;
	}

	/**
	 * Submit one task into the peer's bound session and start following it.
	 * @param text - the task text.
	 * @param classified - correlation data from the inbound message.
	 */
	async submitTask(text, classified) {
		const binding = this.storage.readBindings(this.root)[classified.fromUserId];
		if (binding === undefined) {
			await this.reply(NO_BINDING_REPLY);
			return;
		}
		if (this.paused.has(binding.sessionId)) {
			/* `/stop` promised the queue stays stopped until an explicit resume. */
			await this.reply(PAUSED_REPLY);
			return;
		}
		await this.submitInto({
			text,
			requestId: `weixin-${classified.messageId}`,
			sessionId: binding.sessionId,
			contextToken: classified.contextToken ?? '',
		});
	}

	/**
	 * Submit one task into one session and start following it.
	 * @param options - task text, request identity, and target session.
	 * @returns whether the task was accepted for execution.
	 */
	async submitInto({ text, requestId, sessionId, bodyPrefix = '', contextToken = this.contextToken }) {
		let agent = typeof this.agents.get === 'function' ? this.agents.get(sessionId) : undefined;
		if (agent === undefined && typeof this.agents.resume === 'function') {
			try {
				const published = await this.agents.resume({ resumeSessionId: sessionId });
				agent = published?.agent ?? published;
			} catch (error) {
				await this.reply(`会话 ${sessionId} 无法恢复：${String(error?.message ?? error)}`);
				return false;
			}
		}
		if (agent === undefined) {
			await this.reply(`会话 ${sessionId} 当前不可用，请用 /use 重新选择会话。`);
			return false;
		}
		let first = true;
		const tracker = new TaskTracker({
			requestId,
			sessionId,
			now: this.now,
			body: (segment) => {
				const decorated = first && bodyPrefix !== '' ? `${bodyPrefix}${segment}` : segment;
				first = false;
				return this.scheduler.enqueue('body', decorated, { runId: requestId, contextToken });
			},
			status: (line) => this.scheduler.enqueue('status', line, { runId: requestId, contextToken }),
		});
		this.trackers.set(requestId, tracker);
		/* Marked before the attempt: a crash from here on must not re-run the task. */
		this.markInflight({ messageId: requestId, requestId, sessionId, text });
		try {
			await this.typing(1);
			agent.followup(buildRequestMessage(requestId, text));
		} catch (error) {
			this.trackers.delete(requestId);
			tracker.abandon('submit-failed');
			this.clearInflight();
			await this.reply(SUBMIT_FAILED_PREFIX + String(error?.message ?? error));
			return false;
		}
		this.clearInflight();
		this.onStatus({ kind: 'submitted', requestId, sessionId });
		return true;
	}

	/** Attribute one live assistant frame to a tracker. */
	onAgentFrame(agent, frame) {
		for (const tracker of this.trackers.values()) tracker.ingestFrame(agent, frame);
	}

	/** Attribute one durable session event, and retire trackers that finished. */
	onSessionEvent(session, event) {
		for (const [requestId, tracker] of this.trackers) {
			tracker.ingestEvent(session, event);
			if (!tracker.active) {
				this.trackers.delete(requestId);
				/* Reported after delivery settles, so a send failure is attributed. */
				this.#reportSettled(tracker).catch(() => {});
			}
		}
	}

	/** Report one settled task once its deliveries have been attempted. */
	async #reportSettled(tracker) {
		await tracker.whenDelivered();
		const summary = tracker.summary();
		if (summary.bodyError !== '') this.noteReplyError(summary.bodyError);
		this.onStatus({ kind: 'settled', ...summary });
		this.typing(2).catch(() => {});
	}

	/** Attribute the inbox claim that ties a submitted message to its turn. */
	onInboxClaimed(message, turn) {
		const tracker = this.trackers.get(message?.id);
		if (tracker === undefined) return;
		tracker.claim(message.id, turn);
	}

	/** Attribute an agent-level failure. */
	onAgentError(agent, error) {
		for (const tracker of this.trackers.values()) {
			if (tracker.ingestError(agent, error)) {
				this.onStatus({ kind: 'error', requestId: tracker.requestId, error: tracker.error });
			}
		}
	}

	/** Abandon trackers whose deadline passed, reporting each once. */
	sweepExpired() {
		for (const [requestId, tracker] of this.trackers) {
			if (!tracker.expired(this.now())) continue;
			tracker.abandon('timeout');
			this.trackers.delete(requestId);
			this.onStatus({ kind: 'timeout', requestId });
			this.reply('任务超时未结束，已停止等待；DSH 中的执行状态请以会话界面为准。').catch(() => {});
			this.typing(2).catch(() => {});
		}
	}

	/**
	 * Fire every schedule that is due, and record the ones that were missed.
	 *
	 * Nothing is ever run late: a slot older than the grace window is recorded as
	 * missed and the counter advances, so a task meant for 03:00 cannot execute at
	 * 09:00 because the service was down. Each firing re-checks its own
	 * preconditions — the binding still points at the same session, the recorded
	 * directory still exists, the session is resolvable — and a failure is recorded
	 * on the entry rather than re-routed to another session.
	 *
	 * Entries belonging to a different peer are left alone entirely: after the
	 * account is replaced, a previous WeChat account's schedule must neither run
	 * nor have its result delivered to the new account.
	 * @returns how many occurrences were fired, marked missed, or held by a pause.
	 */
	async fireDueSchedules() {
		const now = this.now();
		if (now < this.nextScheduleCheckAt) return { fired: 0, missed: 0, held: 0 };
		this.nextScheduleCheckAt = now + SCHEDULE_CHECK_INTERVAL_MS;
		const document = this.storage.readSchedules(this.root);
		if (document.entries.length === 0) return { fired: 0, missed: 0, held: 0 };
		const mine = document.entries.filter((entry) => entry.peer === this.account.userId);
		if (mine.length === 0) return { fired: 0, missed: 0, held: 0 };
		const { due, missed } = classifyDue(mine, now);
		if (due.length === 0 && missed.length === 0) return { fired: 0, missed: 0, held: 0 };
		const settled = new Map();
		for (const entry of missed) {
			settled.set(entry.id, applyOutcome(entry, now, 'missed'));
			this.onStatus({ kind: 'schedule-missed', scheduleId: entry.id });
		}
		let fired = 0;
		let held = 0;
		for (const entry of due) {
			/* A paused session must not be woken by scheduled work either: leave the
			 * entry untouched so it can still run inside its grace window once the
			 * user resumes, and let the normal path mark it missed afterwards. */
			if (this.paused.has(entry.sessionId)) {
				held += 1;
				this.onStatus({ kind: 'schedule-held', scheduleId: entry.id });
				continue;
			}
			const outcome = await this.#fireSchedule(entry);
			settled.set(entry.id, applyOutcome(entry, now, outcome));
			if (outcome === 'fired') fired += 1;
			this.onStatus({ kind: outcome === 'fired' ? 'schedule-fired' : 'schedule-failed', scheduleId: entry.id });
		}
		const entries = document.entries.map((entry) => settled.get(entry.id) ?? entry);
		this.storage.writeSchedules(this.root, { nextId: document.nextId, entries });
		return { fired, missed: missed.length, held };
	}

	/**
	 * Remove every schedule that belongs to one peer (used when that WeChat
	 * account logs out): its plans must not survive into a different account.
	 * @param peer - the peer identity that is leaving.
	 * @returns how many entries were removed.
	 */
	dropSchedulesFor(peer) {
		return this.storage.removeSchedulesForPeer(this.root, peer);
	}

	/**
	 * Re-check one due occurrence and submit it.
	 * @param entry - the due schedule entry.
	 * @returns the outcome to record: `'fired'` or `'failed'`.
	 */
	async #fireSchedule(entry) {
		const binding = this.storage.readBindings(this.root)[entry.peer];
		if (binding === undefined) {
			this.reply(`定时任务 ${entry.id} 未执行：该微信用户已取消绑定会话。`).catch(() => {});
			return 'failed';
		}
		if (binding.sessionId !== entry.sessionId) {
			this.reply(`定时任务 ${entry.id} 未执行：绑定会话已变更，不会改投其他会话。`).catch(() => {});
			return 'failed';
		}
		if (entry.cwd !== '') {
			const checked = validateDirectory(entry.cwd);
			if (!checked.ok) {
				this.reply(`定时任务 ${entry.id} 未执行：工作目录不可用（${checked.reason}）。`).catch(() => {});
				return 'failed';
			}
		}
		const requestId = occurrenceId(entry, entry.sequence);
		const accepted = await this.submitInto({
			text: entry.text,
			requestId,
			sessionId: entry.sessionId,
			bodyPrefix: `【定时任务 ${entry.id}】`,
		});
		return accepted ? 'fired' : 'failed';
	}

	/**
	 * Poll once and handle the batch, applying the documented failure policy.
	 * @returns a short outcome tag for the caller's logs.
	 */
	async tick() {
		if (this.stopped) return 'stopped';
		let answer;
		try {
			answer = await this.transport.pollUpdates({
				token: this.account.botToken,
				version: this.version,
				cursor: this.cursor,
			});
		} catch (error) {
			this.failures += 1;
			this.onStatus({ kind: 'poll-failed', error: String(error?.message ?? error), failures: this.failures });
			await this.sleep(this.failures >= FAILURES_BEFORE_BACKOFF ? RETRY_LONG_MS : RETRY_SHORT_MS);
			return 'retry';
		}
		if (answer.stale === true) {
			this.stale = true;
			this.stop('stale-credential');
			this.onStatus({ kind: 'stale-credential' });
			return 'stale';
		}
		this.failures = 0;
		if (this.baselinePending) {
			this.baselinePending = false;
			let skipped = 0;
			for (const message of answer.messages) {
				const classified = classifyInbound(message, { boundUserId: this.account.userId, seen: this.seen });
				if (classified.kind !== 'text') continue;
				if (typeof classified.contextToken === 'string') this.contextToken = classified.contextToken;
				this.#remember(classified.messageId, undefined);
				this.onStatus({ kind: 'offline-message-skipped', messageId: classified.messageId });
				skipped += 1;
			}
			if (answer.cursor !== this.cursor) this.#remember(undefined, answer.cursor);
			if (skipped > 0) await this.reply(`连接初始化时跳过了 ${skipped} 条既有消息，以避免执行停机期间积压的高权限任务。请重新发送需要执行的命令或任务。`).catch(() => {});
			return 'baseline';
		}
		this.sweepExpired();
		await this.fireDueSchedules();
		if (answer.messages.length > 0) await this.handleBatch(answer);
		else {
			if (answer.cursor !== this.cursor) this.#remember(undefined, answer.cursor);
			/* Nothing arrived and the answer was not held open: yield before re-polling. */
			if (answer.timedOut !== true) await this.sleep(this.suggestedIdle(answer));
		}
		return answer.timedOut === true ? 'idle' : 'ok';
	}

	/** Idle wait between polls: the server's own suggestion, kept inside a sane band. */
	suggestedIdle(answer) {
		const suggested = Number.isFinite(answer.suggestedTimeoutMs) ? answer.suggestedTimeoutMs : IDLE_DELAY_MS;
		return Math.min(Math.max(suggested, IDLE_DELAY_MS), IDLE_MAX_MS);
	}

	/**
	 * Run the loop until stopped.
	 *
	 * Each iteration is awaited in sequence, so a long poll never stacks on the
	 * previous one.
	 */
	async run() {
		/* Report any submission left unconfirmed by a crash before polling again. */
		await this.reportUnconfirmed().catch(() => {});
		while (!this.stopped) {
			let outcome;
			try {
				outcome = await this.tick();
			} catch (error) {
				/* An unexpected failure must not end receiving: the loop backs off and
				 * retries, so a transient storage or handler fault costs one poll. */
				this.failures += 1;
				this.onStatus({ kind: 'loop-failed', error: String(error?.message ?? error), failures: this.failures });
				await this.sleep(this.failures >= FAILURES_BEFORE_BACKOFF ? RETRY_LONG_MS : RETRY_SHORT_MS);
				continue;
			}
			if (outcome === 'stopped' || outcome === 'stale') break;
		}
	}
}

export {
	FAILURES_BEFORE_BACKOFF, IDLE_DELAY_MS, NO_BINDING_REPLY, PAUSED_REPLY, RETRY_LONG_MS,
	RETRY_SHORT_MS, SCHEDULE_CHECK_INTERVAL_MS, SUBMIT_FAILED_PREFIX, TYPING_TICKET_TTL_MS,
	UNCONFIRMED_REPLY, ChannelLoop,
};
