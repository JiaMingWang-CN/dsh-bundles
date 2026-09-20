/**
 * Outbound text segmentation and the send scheduler.
 *
 * The plan's output rules, made explicit here:
 *
 * - Segment on natural boundaries and never lose or reorder a character: the
 *   concatenation of the segments is exactly the reply text, so the user can
 *   reassemble the answer and nothing is duplicated at the end.
 * - Body text outranks status chatter. Status messages are coalesced and may be
 *   dropped entirely; a dropped or failed status must never delay or replace the
 *   answer body.
 * - One send at a time with a minimum gap, because the server's real rate limit
 *   is unknown (the reference project documents none) and the safe default is to
 *   under-send rather than to be throttled mid-answer.
 */

/** Default segment length; conservative because the server's limit is unverified. */
const DEFAULT_SEGMENT_CHARS = 1200;

/** Default minimum gap between two sends. */
const DEFAULT_MIN_INTERVAL_MS = 900;

/** Marks a half of a surrogate pair, so a segment never splits an emoji. */
function isHighSurrogate(code) {
	return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Split one boundary index so it never separates a surrogate pair.
 * @param text - the text being split.
 * @param index - the candidate split index.
 * @returns an adjusted index.
 */
function safeBoundary(text, index) {
	if (index <= 0 || index >= text.length) return index;
	const before = text.charCodeAt(index - 1);
	return isHighSurrogate(before) ? index - 1 : index;
}

/**
 * Find a natural split point at or before `limit`.
 *
 * Preference order: a blank-line paragraph break, a newline, a sentence end
 * (CJK or ASCII), a space, and finally the raw limit — so a single long token
 * still gets split rather than being sent oversized. Each candidate carries the
 * length of its own boundary characters, so a paragraph break stays intact.
 * @param text - remaining text.
 * @param limit - maximum characters for this segment.
 * @returns the split index.
 */
function findSplit(text, limit) {
	if (text.length <= limit) return text.length;
	const window = text.slice(0, limit + 1);
	const paragraph = window.lastIndexOf('\n\n');
	const newline = window.lastIndexOf('\n');
	const sentence = Math.max(
		window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'),
		window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '),
	);
	const space = window.lastIndexOf(' ');
	const candidates = [
		[paragraph, 2],
		[newline, 1],
		[sentence, sentence >= 0 ? (window.startsWith('. ', sentence) || window.startsWith('! ', sentence) || window.startsWith('? ', sentence) ? 2 : 1) : 1],
		[space, 1],
	];
	for (const [index, width] of candidates) {
		if (index <= 0) continue;
		const end = index + width;
		const cut = end <= limit ? end : index;
		return safeBoundary(text, cut);
	}
	return safeBoundary(text, limit);
}

/** Convert common Markdown constructs into readable WeChat plain text. */
function formatWeixinText(text) {
	const source = typeof text === 'string' ? text : String(text ?? '');
	let inCode = false;
	const lines = source.replace(/\r\n?/g, '\n').split('\n');
	const output = [];
	for (const line of lines) {
		if (/^\s*```/.test(line)) {
			output.push(inCode ? '【代码结束】' : '【代码】');
			inCode = !inCode;
			continue;
		}
		if (!inCode && /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line)) continue;
		if (!inCode && /^\s*#{1,6}\s+/.test(line)) {
			output.push(`【${line.replace(/^\s*#{1,6}\s+/, '').trim()}】`);
			continue;
		}
		if (!inCode && /^\s*\|.*\|\s*$/.test(line)) {
			output.push(line.trim().slice(1, -1).split('|').map((cell) => cell.trim()).join(' ｜ '));
			continue;
		}
		output.push(inCode ? line : line
			.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1（$2）')
			.replace(/\*\*([^*]+)\*\*/g, '$1')
			.replace(/__([^_]+)__/g, '$1'));
	}
	if (inCode) output.push('【代码结束】');
	return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Split a reply into sendable segments.
 * @param text - the full reply text.
 * @param maxChars - maximum characters per segment.
 * @returns segments whose concatenation is exactly the input.
 */
function segmentText(text, maxChars = DEFAULT_SEGMENT_CHARS) {
	const source = typeof text === 'string' ? text : String(text ?? '');
	const limit = Number.isSafeInteger(maxChars) && maxChars > 0 ? maxChars : DEFAULT_SEGMENT_CHARS;
	if (source === '') return [];
	const segments = [];
	let rest = source;
	while (rest.length > limit) {
		const at = findSplit(rest, limit);
		const cut = at <= 0 ? limit : at;
		segments.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	if (rest !== '') segments.push(rest);
	return segments;
}

/**
 * Serialized sender with a minimum gap and body-over-status priority.
 *
 * `enqueue` resolves once its own item has been attempted; a status item that
 * cannot be sent (or was superseded by a newer one) resolves as `dropped`
 * instead of failing, and a body failure is reported to its own caller only.
 */
class SendScheduler {
	/**
	 * @param options - transport, gap, clock, and sleep.
	 */
	constructor({ send, minIntervalMs = DEFAULT_MIN_INTERVAL_MS, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
		this.send = send;
		this.minIntervalMs = minIntervalMs;
		this.now = now;
		this.sleep = sleep;
		this.queue = [];
		this.running = false;
		this.lastSentAt = 0;
	}

	/**
	 * Queue one item.
	 * @param kind - `'body'` for reply text, `'status'` for droppable chatter.
	 * @param text - the text to send.
	 * @param options - optional task run id and frozen inbound context token.
	 * @returns `{ ok, dropped?, error? }`.
	 */
	enqueue(kind, text, options = {}) {
		const done = Promise.withResolvers();
		if (kind === 'status') {
			/* Only the newest status matters; a superseded one must still settle. */
			for (const item of this.queue) {
				if (item.kind === 'status') item.done.resolve({ ok: false, dropped: 'superseded' });
			}
			this.queue = this.queue.filter((item) => item.kind !== 'status');
		}
		this.queue.push({ kind, text, runId: options.runId, contextToken: options.contextToken, done });
		this.#pump();
		return done.promise;
	}

	/** Number of queued items; exposed for diagnostics and tests. */
	get pending() {
		return this.queue.length;
	}

	/** Process the queue serially, one send at a time. */
	async #pump() {
		if (this.running) return;
		this.running = true;
		try {
			while (this.queue.length > 0) {
				const item = this.queue.shift();
				if (item.kind === 'status' && this.queue.some((other) => other.kind === 'body')) {
					item.done.resolve({ ok: false, dropped: 'superseded-by-body' });
					continue;
				}
				const wait = this.minIntervalMs - (this.now() - this.lastSentAt);
				if (wait > 0) await this.sleep(wait);
				try {
					await this.send(item.text, item.kind, { runId: item.runId, contextToken: item.contextToken });
					this.lastSentAt = this.now();
					item.done.resolve({ ok: true });
				} catch (error) {
					if (item.kind === 'status') item.done.resolve({ ok: false, dropped: 'status-failed' });
					else item.done.resolve({ ok: false, error: String(error?.message ?? error) });
				}
			}
		} finally {
			this.running = false;
		}
	}
}

export {
	DEFAULT_MIN_INTERVAL_MS, DEFAULT_SEGMENT_CHARS, SendScheduler, findSplit, formatWeixinText, safeBoundary, segmentText,
};
