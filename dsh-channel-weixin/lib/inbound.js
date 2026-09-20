/**
 * Inbound message classification and duplicate suppression.
 *
 * The plan fixes what may become a DSH task: only text the bound WeChat user
 * sent in a one-to-one chat. Everything else — the bot's own messages, group
 * traffic, other contacts, media items, and repeats of an already-handled
 * message id — is dropped here, before any session or model sees it.
 *
 * A media message is ignored rather than turned into a task, which is the
 * first-version boundary the plan sets: no attachment download, no automatic
 * voice transcription.
 */

import { ITEM_TYPE_TEXT, MESSAGE_TYPE_BOT } from './weixin.js';

/** Why one message was not turned into a task. */
const IGNORE_REASONS = {
	'not-an-object': 'malformed message',
	'own-message': 'sent by this bot',
	group: 'group chat is not supported in this version',
	'other-sender': 'sender is not the bound user',
	empty: 'no text content',
	unsupported: 'unsupported message type',
	duplicate: 'already handled',
	'missing-id': 'message has no usable identity',
};

/** Bounded size of the duplicate-suppression window. */
const DEDUPE_LIMIT = 500;

/**
 * Text of one message item list.
 *
 * Only a completed text item counts; a voice item is not transcribed and a media
 * item is not fetched, so both report `unsupported` to the caller instead of
 * producing text this plugin did not verify.
 * @param message - one inbound message.
 * @returns `{ kind: 'text', text }` or `{ kind: 'unsupported' }`.
 */
function extractText(message) {
	const items = Array.isArray(message?.item_list) ? message.item_list : [];
	let sawTextItem = false;
	for (const item of items) {
		if (item === null || typeof item !== 'object') continue;
		if (item.type !== ITEM_TYPE_TEXT) continue;
		sawTextItem = true;
		if (typeof item.text_item?.text !== 'string') continue;
		const text = item.text_item.text.trim();
		if (text !== '') return { kind: 'text', text };
	}
	/* A text item that carries nothing is an empty message, not an unsupported one. */
	if (sawTextItem) return { kind: 'empty' };
	return { kind: items.length === 0 ? 'empty' : 'unsupported' };
}

/**
 * Classify one inbound message.
 * @param message - one message from `getupdates`.
 * @param options - the bound peer identity and the duplicate window.
 * @returns `{ kind: 'text', ... }` for an actionable message, otherwise `{ kind: 'ignored', reason }`.
 */
function classifyInbound(message, { boundUserId, seen } = {}) {
	if (message === null || typeof message !== 'object') return { kind: 'ignored', reason: 'not-an-object' };
	if (message.message_type === MESSAGE_TYPE_BOT) return { kind: 'ignored', reason: 'own-message' };
	if (typeof message.group_id === 'string' && message.group_id !== '') return { kind: 'ignored', reason: 'group' };
	/* Fail closed: full-access tasks are allowed only after login identified the
	 * scanning user. An absent identity must never mean "accept any sender". */
	if (typeof boundUserId !== 'string' || boundUserId === '') return { kind: 'ignored', reason: 'missing-bound-user' };
	const fromUserId = typeof message.from_user_id === 'string' ? message.from_user_id : '';
	if (fromUserId !== boundUserId) return { kind: 'ignored', reason: 'other-sender' };
	const id = typeof message.message_id === 'string' && message.message_id !== '' ? message.message_id : '';
	if (id === '') return { kind: 'ignored', reason: 'missing-id' };
	if (seen !== undefined && typeof seen.has === 'function' && seen.has(id)) return { kind: 'ignored', reason: 'duplicate' };
	const extracted = extractText(message);
	if (extracted.kind !== 'text') return { kind: 'ignored', reason: extracted.kind === 'empty' ? 'empty' : 'unsupported' };
	return {
		kind: 'text',
		text: extracted.text,
		messageId: id,
		fromUserId,
		...(typeof message.context_token === 'string' && message.context_token !== '' ? { contextToken: message.context_token } : {}),
		...(Number.isFinite(message.create_time_ms) ? { createdAt: message.create_time_ms } : {}),
	};
}

/**
 * Bounded, insertion-ordered window of handled message ids.
 *
 * The window lives in the persisted channel state together with the poll
 * cursor, so a restart does not re-handle a message whose cursor already moved.
 */
class DedupeWindow {
	/** @param limit - maximum remembered ids. */
	constructor(limit = DEDUPE_LIMIT) {
		this.limit = limit;
		this.order = [];
		this.index = new Set();
	}

	/** Whether one id is already inside the window. */
	has(id) {
		return this.index.has(id);
	}

	/** Remember one id, evicting the oldest entries beyond the limit. */
	add(id) {
		if (typeof id !== 'string' || id === '' || this.index.has(id)) return false;
		this.index.add(id);
		this.order.push(id);
		while (this.order.length > this.limit) {
			const evicted = this.order.shift();
			this.index.delete(evicted);
		}
		return true;
	}

	/** The remembered ids, oldest first. */
	toArray() {
		return [...this.order];
	}

	/** Rebuild a window from persisted ids. */
	static from(ids, limit = DEDUPE_LIMIT) {
		const window = new DedupeWindow(limit);
		for (const id of Array.isArray(ids) ? ids : []) window.add(id);
		return window;
	}
}

export { DEDUPE_LIMIT, DedupeWindow, IGNORE_REASONS, classifyInbound, extractText };
