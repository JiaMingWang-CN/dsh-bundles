import assert from 'node:assert/strict';
import test from 'node:test';

import { DedupeWindow, classifyInbound, extractText } from '../lib/inbound.js';

/** One inbound text message from the bound user. */
function textMessage(id, text, extra = {}) {
	return {
		message_id: id,
		from_user_id: 'user-1',
		to_user_id: 'bot-1',
		message_type: 1,
		item_list: [{ type: 1, text_item: { text } }],
		context_token: 'token-1',
		create_time_ms: 1700000000000,
		...extra,
	};
}

test('a bound user text message becomes a task with its correlation fields', () => {
	const classified = classifyInbound(textMessage('m-1', ' 你好 '), { boundUserId: 'user-1' });
	assert.equal(classified.kind, 'text');
	assert.equal(classified.text, '你好');
	assert.equal(classified.messageId, 'm-1');
	assert.equal(classified.fromUserId, 'user-1');
	assert.equal(classified.contextToken, 'token-1');
	assert.equal(classified.createdAt, 1700000000000);
});

test("the bot's own message never becomes a task", () => {
	const classified = classifyInbound(textMessage('m-2', '回复', { message_type: 2 }), { boundUserId: 'user-1' });
	assert.deepEqual(classified, { kind: 'ignored', reason: 'own-message' });
});

test('group traffic is refused in this version', () => {
	const classified = classifyInbound(textMessage('m-3', '大家好', { group_id: 'group-9' }), { boundUserId: 'user-1' });
	assert.equal(classified.reason, 'group');
});

test('another contact is refused even with valid text', () => {
	const classified = classifyInbound(textMessage('m-4', 'hello', { from_user_id: 'someone-else' }), { boundUserId: 'user-1' });
	assert.equal(classified.reason, 'other-sender');
});

test('without a bound identity the sender filter fails closed', () => {
	const classified = classifyInbound(textMessage('m-5', 'hi'), {});
	assert.equal(classified.reason, 'missing-bound-user');
});

test('media and voice items are unsupported rather than guessed at', () => {
	const image = classifyInbound(textMessage('m-6', '', { item_list: [{ type: 2, image_item: { url: 'https://x' } }] }), { boundUserId: 'user-1' });
	assert.equal(image.reason, 'unsupported');
	const voice = classifyInbound(textMessage('m-7', '', { item_list: [{ type: 3, voice_item: { text: '转写文本' } }] }), { boundUserId: 'user-1' });
	assert.equal(voice.reason, 'unsupported', 'voice must not be treated as text in this version');
	const mixed = classifyInbound(textMessage('m-8', '', { item_list: [{ type: 2, image_item: {} }, { type: 1, text_item: { text: 'caption' } }] }), { boundUserId: 'user-1' });
	assert.equal(mixed.kind, 'text');
	assert.equal(mixed.text, 'caption');
});

test('an empty or whitespace-only text message is ignored', () => {
	assert.equal(classifyInbound(textMessage('m-9', '   '), { boundUserId: 'user-1' }).reason, 'empty');
	assert.equal(classifyInbound(textMessage('m-10', '', { item_list: [] }), { boundUserId: 'user-1' }).reason, 'empty');
});

test('a message without an identity is ignored, so it cannot be deduplicated', () => {
	const message = textMessage('m-11', 'hi');
	delete message.message_id;
	assert.equal(classifyInbound(message, { boundUserId: 'user-1' }).reason, 'missing-id');
});

test('a malformed entry does not throw', () => {
	assert.equal(classifyInbound(null, {}).reason, 'not-an-object');
	assert.equal(classifyInbound('text', {}).reason, 'not-an-object');
	assert.equal(classifyInbound({ message_id: 'm', from_user_id: 'user-1', item_list: [null, 5, { type: 1 }] }, { boundUserId: 'user-1' }).reason, 'empty');
});

test('extractText reports the empty and unsupported cases distinctly', () => {
	assert.deepEqual(extractText({ item_list: [] }), { kind: 'empty' });
	assert.deepEqual(extractText({}), { kind: 'empty' });
	assert.deepEqual(extractText({ item_list: [{ type: 1, text_item: { text: ' x ' } }] }), { kind: 'text', text: 'x' });
	assert.deepEqual(extractText({ item_list: [{ type: 9 }] }), { kind: 'unsupported' });
});

test('a repeat of a handled message id is ignored', () => {
	const seen = new DedupeWindow(10);
	const first = classifyInbound(textMessage('dup-1', 'hi'), { boundUserId: 'user-1', seen });
	assert.equal(first.kind, 'text');
	seen.add(first.messageId);
	const second = classifyInbound(textMessage('dup-1', 'hi'), { boundUserId: 'user-1', seen });
	assert.equal(second.reason, 'duplicate');
});

test('the duplicate window is bounded and evicts oldest first', () => {
	const window = new DedupeWindow(3);
	for (const id of ['a', 'b', 'c', 'd']) window.add(id);
	assert.deepEqual(window.toArray(), ['b', 'c', 'd']);
	assert.equal(window.has('a'), false);
	assert.equal(window.has('d'), true);
});

test('the duplicate window rebuilds from persisted ids and ignores junk', () => {
	const window = DedupeWindow.from(['x', '', 5, null, 'y']);
	assert.deepEqual(window.toArray(), ['x', 'y']);
	assert.equal(window.add('x'), false, 'adding an existing id is a no-op');
	assert.equal(window.add(undefined), false);
});

test('a non-text sender is never mistaken for the bound user', () => {
	const spoofed = textMessage('m-12', 'run something', { from_user_id: '', message_type: 1 });
	const classified = classifyInbound(spoofed, { boundUserId: 'user-1' });
	assert.equal(classified.reason, 'other-sender');
});
