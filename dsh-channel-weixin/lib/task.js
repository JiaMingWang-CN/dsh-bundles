/**
 * One WeChat request's journey through DSH, and the attribution that keeps it
 * honest.
 *
 * The plan's hardest output requirement is that a reply carries only the output
 * of its own request. This tracker earns that by identity rather than by timing:
 *
 * - The submitted message is created here with this plugin's own id, and the
 *   agent's `agent/inbox/claimed` event later reports which turn claimed that
 *   exact message. Until that happens nothing is attributed, so text produced
 *   for someone else's turn (a browser prompt in the same session, for example)
 *   can never be mistaken for this request's answer.
 * - Only `text-delta` frames are accumulated. Reasoning and tool-call fragments
 *   are dropped by construction, which is what "never send hidden reasoning"
 *   means mechanically.
 * - Tool chatter is derived from durable `tool/call` / `tool/result` events and
 *   carries the tool name only — never arguments, output, or file content.
 */

import { formatWeixinText, segmentText } from './reply.js';

/** How much visible text accumulates before a segment is sent mid-task. */
const STREAM_FLUSH_CHARS = 600;

/** A task that never reaches a turn boundary is abandoned after this long. */
const TASK_TIMEOUT_MS = 30 * 60_000;

/** Reply text for a finished task that produced no visible text at all. */
const NO_TEXT_REPLY = '（任务已完成，没有文字输出。）';

/** Source stamped on every message this plugin submits. */
const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'dsh-channel-weixin' };

/** Compact correlation label shown in every task message. */
function taskShortId(requestId) {
	const value = String(requestId ?? '').replace(/^weixin-/, '');
	return value.length <= 8 ? value : value.slice(-8);
}

/** Human-readable elapsed time without fake precision. */
function formatDuration(ms) {
	const seconds = Math.max(0, Math.round(Number(ms) / 1000));
	if (seconds < 60) return `${seconds}秒`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return rest === 0 ? `${minutes}分` : `${minutes}分${rest}秒`;
}

/**
 * Build the user message this plugin submits into a session.
 *
 * The message id is the plugin's own request id, which is what makes
 * `agent/inbox/claimed` usable as the attribution signal.
 * @param requestId - this plugin's request identity.
 * @param text - the user's task text.
 * @returns a harness-shaped user message.
 */
function buildRequestMessage(requestId, text) {
	return {
		id: requestId,
		role: 'user',
		content: [{ type: 'text', text: String(text ?? '') }],
		source: PLUGIN_SOURCE,
	};
}

/**
 * Follow one submitted request from acceptance to a finished reply.
 *
 * `body` and `status` are the transport callbacks (typically the send
 * scheduler): `status` is droppable chatter, `body` is the answer itself.
 */
class TaskTracker {
	/**
	 * @param options - request/session identity, clock, and the two send callbacks.
	 */
	constructor({ requestId, sessionId, now = Date.now, timeoutMs = TASK_TIMEOUT_MS, streamFlushChars = STREAM_FLUSH_CHARS, body, status }) {
		this.requestId = requestId;
		this.sessionId = sessionId;
		this.now = now;
		this.timeoutMs = timeoutMs;
		this.streamFlushChars = streamFlushChars;
		this.body = body;
		this.status = status ?? (async () => ({ ok: true }));
		this.turn = undefined;
		this.state = 'submitted';
		this.pending = '';
		this.sentChars = 0;
		this.startedAt = now();
		this.finishedAt = 0;
		this.error = '';
		this.toolNames = new Map();
		this.toolKinds = new Set();
		this.toolCalls = 0;
		this.toolEvents = 0;
		this.bodyError = '';
		/** In-flight body deliveries, so a caller can wait for their outcomes. */
		this.deliveries = new Set();
	}

	/** Whether this tracker still awaits a terminal turn boundary. */
	get active() {
		return this.state === 'submitted' || this.state === 'running';
	}

	/** Channels already delivered (for diagnostics and tests). */
	get deliveredChars() {
		return this.sentChars;
	}

	/** Whether the task exceeded its own deadline. */
	expired(now = this.now()) {
		return this.active && now - this.startedAt > this.timeoutMs;
	}

	/** Record the turn that claimed this request. Idempotent; a wrong id is refused. */
	claim(messageId, turn) {
		if (messageId !== this.requestId) return false;
		if (!Number.isFinite(turn)) return false;
		if (this.turn !== undefined && this.turn !== turn) return false;
		this.turn = turn;
		if (this.state === 'submitted') {
			this.state = 'running';
			this.#sendStatus(`▶️ [${taskShortId(this.requestId)}] 已开始`);
		}
		return true;
	}

	/**
	 * Consume one live assistant frame.
	 * @param agent - the agent the frame belongs to.
	 * @param frame - one dense assistant frame.
	 * @returns whether the frame was attributed to this request.
	 */
	ingestFrame(agent, frame) {
		if (!this.active) return false;
		if (this.turn === undefined) return false;
		if (agent?.session?.id !== this.sessionId) return false;
		if (frame?.turn !== undefined && frame.turn !== this.turn) return false;
		if (frame?.type !== 'chunk') return false;
		const chunk = frame.chunk;
		if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string' || chunk.text === '') return false;
		/* Buffer until the terminal boundary so every segment can carry an accurate
		 * [current/total] marker. Tool status still provides live progress. */
		this.pending += chunk.text;
		return true;
	}

	/**
	 * Consume one durable session event.
	 * @param session - the session the event belongs to.
	 * @param event - one session event record.
	 * @returns whether the event was attributed to this request.
	 */
	ingestEvent(session, event) {
		if (session?.id !== this.sessionId) return false;
		const data = event?.data;
		if (data === null || typeof data !== 'object') return false;
		if (this.turn !== undefined && Number.isFinite(data.turn) && data.turn !== this.turn) return false;
		switch (event.type) {
			case 'tool/call': {
				if (this.turn === undefined) return false;
				const name = typeof data.name === 'string' && data.name !== '' ? data.name : '未知工具';
				if (typeof data.callId === 'string') this.toolNames.set(data.callId, name);
				this.toolEvents += 1;
				this.toolCalls += 1;
				const isNewKind = !this.toolKinds.has(name);
				this.toolKinds.add(name);
				if (isNewKind) {
					this.#sendStatus(`🔧 [${taskShortId(this.requestId)}] 执行中：${[...this.toolKinds].join('、')}（共 ${this.toolCalls} 次）`);
				}
				return true;
			}
			case 'tool/result': {
				if (this.turn === undefined) return false;
				const callId = typeof data.message?.callId === 'string' ? data.message.callId : '';
				const name = this.toolNames.get(callId) ?? '工具';
				const failed = data.error !== undefined || data.message?.isError === true;
				this.toolEvents += 1;
				if (failed) this.#sendStatus(`⚠️ [${taskShortId(this.requestId)}] 工具 ${name} 失败`);
				return true;
			}
			case 'turn/end': {
				if (this.turn === undefined || data.turn !== this.turn) return false;
				this.finish();
				return true;
			}
			default:
				return false;
		}
	}

	/**
	 * Record an agent-level failure. Only a failure on this request's turn (or one
	 * raised before a turn was claimed for this session) is attributed.
	 * @param agent - the failing agent.
	 * @param error - the reported error.
	 * @returns whether the failure belongs to this request.
	 */
	ingestError(agent, error) {
		if (!this.active) return false;
		if (agent?.session?.id !== this.sessionId) return false;
		this.error = String(error?.message ?? error ?? '未知错误');
		return true;
	}

	/** Abandon the task without claiming it finished (cancel, timeout, or unload). */
	abandon(reason) {
		if (!this.active) return;
		this.state = 'cancelled';
		this.error = this.error === '' ? reason : this.error;
		this.finishedAt = this.now();
	}

	/**
	 * Reach the terminal boundary: flush the remaining text and report.
	 *
	 * A failed task still delivers the visible text it produced before the failure,
	 * followed by the failure line: dropping the tail would throw away finished
	 * work, while sending it without the marker would disguise a failure as a
	 * complete answer. A cancelled task sends neither (see {@link abandon}).
	 * @returns a summary of what was delivered.
	 */
	finish() {
		if (!this.active) return this.summary();
		this.state = this.error === '' ? 'done' : 'failed';
		this.finishedAt = this.now();
		const label = taskShortId(this.requestId);
		const text = formatWeixinText(this.pending);
		this.pending = '';
		if (text !== '') {
			const segments = segmentText(text, this.streamFlushChars);
			for (let index = 0; index < segments.length; index += 1) {
				this.#sendBody(`📄 [${label}] [${index + 1}/${segments.length}]\n${segments[index]}`);
			}
		} else if (this.error === '') {
			this.#sendBody(`📄 [${label}]\n${NO_TEXT_REPLY}`);
		}
		const elapsed = formatDuration(this.finishedAt - this.startedAt);
		const toolSummary = this.toolCalls === 0 ? '' : ` · 工具 ${this.toolCalls} 次`;
		if (this.error !== '') this.#sendBody(`❌ [${label}] 失败：${this.error}`);
		else this.#sendBody(`✅ [${label}] 已完成 · 用时 ${elapsed}${toolSummary}`);
		return this.summary();
	}

	/** What the caller records and may report. */
	summary() {
		return {
			requestId: this.requestId,
			sessionId: this.sessionId,
			turn: this.turn,
			state: this.state,
			deliveredChars: this.sentChars,
			toolEvents: this.toolEvents,
			error: this.error,
			bodyError: this.bodyError,
		};
	}

	/**
	 * Resolve once every body segment queued so far has been attempted.
	 *
	 * Delivery is asynchronous, so a caller that wants to report the outcome
	 * (a delivery failure must stay visible) has to wait for it rather than read
	 * the summary immediately at the turn boundary.
	 * @returns a promise resolving after all queued deliveries settle.
	 */
	whenDelivered() {
		return Promise.allSettled([...this.deliveries]);
	}

	/** Queue one body segment, remembering a delivery failure without retrying work. */
	#sendBody(segment) {
		if (segment === '') return;
		this.sentChars += segment.length;
		const delivery = Promise.resolve(this.body(segment)).then((result) => {
			if (result !== undefined && result.ok === false && result.error !== undefined && this.bodyError === '') {
				this.bodyError = String(result.error);
			}
		}).catch((error) => {
			if (this.bodyError === '') this.bodyError = String(error?.message ?? error);
		}).finally(() => {
			this.deliveries.delete(delivery);
		});
		this.deliveries.add(delivery);
	}

	/** Queue one droppable status line. */
	#sendStatus(line) {
		Promise.resolve(this.status(line)).catch(() => {});
	}
}

export {
	NO_TEXT_REPLY, PLUGIN_SOURCE, STREAM_FLUSH_CHARS, TASK_TIMEOUT_MS, TaskTracker,
	buildRequestMessage, formatDuration, taskShortId,
};
