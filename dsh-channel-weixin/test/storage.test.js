import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { accountPath, bindingsPath, channelStatePath, clearAccount, clearBinding, parseAccount, readAccount, readBindings, readChannelState, storageRoot, writeAccount, writeBinding, writeBindings, writeChannelState } from '../lib/storage.js';

const ACCOUNT = {
	botToken: 'bot-token-1',
	baseUrl: 'https://sz.weixin.qq.com',
	botId: 'bot-9',
	userId: 'user-9',
};

/** A throwaway storage root; the caller removes it. */
function tempRoot() {
	return mkdtempSync(join(tmpdir(), 'channel-weixin-'));
}

test('the storage root honors DSH_HOME and otherwise uses the home directory', () => {
	assert.equal(
		storageRoot({ DSH_HOME: 'C:\\dsh-home' }, 'C:\\Users\\someone'),
		join('C:\\dsh-home', 'storages', 'channel-weixin'),
	);
	assert.equal(
		storageRoot({}, join('C:', 'Users', 'someone')),
		join('C:', 'Users', 'someone', '.dsh', 'storages', 'channel-weixin'),
	);
});

test('an account round-trips through the private file', () => {
	const root = tempRoot();
	try {
		assert.equal(readAccount(root), null);
		const saved = writeAccount(root, ACCOUNT);
		assert.equal(saved.botToken, ACCOUNT.botToken);
		assert.equal(readAccount(root).botToken, ACCOUNT.botToken);
		assert.equal(JSON.parse(readFileSync(accountPath(root), 'utf8')).baseUrl, ACCOUNT.baseUrl);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('the credential file is written with owner-only permissions', () => {
	const root = tempRoot();
	try {
		writeAccount(root, ACCOUNT);
		if (process.platform !== 'win32') {
			assert.equal(statSync(accountPath(root)).mode & 0o777, 0o600);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('a corrupt or partial record reads as absent instead of half-configured', () => {
	const root = tempRoot();
	try {
		writeFileSync(accountPath(root), '{not json', 'utf8');
		assert.equal(readAccount(root), null);
		writeFileSync(accountPath(root), JSON.stringify({ botToken: 'tok' }), 'utf8');
		assert.equal(readAccount(root), null);
		writeFileSync(accountPath(root), JSON.stringify({ botToken: 'tok', baseUrl: 'http://insecure.example' }), 'utf8');
		assert.equal(readAccount(root), null);
		writeFileSync(accountPath(root), JSON.stringify(['nope']), 'utf8');
		assert.equal(readAccount(root), null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('stored credentials fail closed without an owner or with an untrusted API host', () => {
	const root = tempRoot();
	try {
		assert.equal(parseAccount({ botToken: 'tok', baseUrl: 'https://weixin.qq.com' }), undefined);
		assert.equal(parseAccount({ botToken: 'tok', baseUrl: 'https://attacker.example', userId: 'user-9' }), undefined);
		assert.throws(() => writeAccount(root, { botToken: 'tok', baseUrl: 'https://attacker.example', userId: 'user-9' }), /invalid WeChat credential/);
		const parsed = parseAccount({ botToken: 'tok', baseUrl: 'https://weixin.qq.com', userId: 'user-9' });
		assert.deepEqual(parsed, { botToken: 'tok', baseUrl: 'https://weixin.qq.com', botId: '', userId: 'user-9', savedAt: 0 });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('logout removes the credential file and is idempotent', () => {
	const root = tempRoot();
	try {
		writeAccount(root, ACCOUNT);
		assert.equal(clearAccount(root), true);
		assert.equal(readAccount(root), null);
		assert.equal(clearAccount(root), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('no temporary file survives a successful write', () => {
	const root = tempRoot();
	try {
		writeAccount(root, ACCOUNT);
		const leftovers = readdirSync(root).filter((entry) => entry.endsWith('.tmp'));
		assert.deepEqual(leftovers, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('a peer binding round-trips without disturbing other peers', () => {
	const root = tempRoot();
	try {
		assert.deepEqual(readBindings(root), {});
		writeBinding(root, 'peer-a', { sessionId: 'session-1', cwd: 'C:\\work' });
		writeBinding(root, 'peer-b', { sessionId: 'session-2' });
		assert.equal(readBindings(root)['peer-a'].sessionId, 'session-1');
		assert.equal(readBindings(root)['peer-a'].cwd, 'C:\\work');
		assert.equal(readBindings(root)['peer-b'].model, '');
		/* Rebinding one peer leaves the other alone. */
		writeBinding(root, 'peer-a', { sessionId: 'session-3' });
		assert.equal(readBindings(root)['peer-a'].sessionId, 'session-3');
		assert.equal(readBindings(root)['peer-b'].sessionId, 'session-2');
		assert.equal(readBindings(root)['peer-a'].updatedAt > 0, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('a damaged or foreign bindings document reads as empty rather than throwing', () => {
	const root = tempRoot();
	try {
		writeFileSync(bindingsPath(root), '{oops', 'utf8');
		assert.deepEqual(readBindings(root), {});
		writeFileSync(bindingsPath(root), JSON.stringify({ version: 99, peers: { a: { sessionId: 'x' } } }), 'utf8');
		assert.deepEqual(readBindings(root), {});
		writeFileSync(bindingsPath(root), JSON.stringify({ version: 1, peers: { a: { sessionId: '' }, b: { sessionId: 'ok' }, c: 5 } }), 'utf8');
		assert.deepEqual(Object.keys(readBindings(root)), ['b']);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('clearing one binding keeps the rest and is idempotent', () => {
	const root = tempRoot();
	try {
		writeBindings(root, { a: { sessionId: 'one' }, b: { sessionId: 'two' } });
		assert.equal(clearBinding(root, 'a'), true);
		assert.deepEqual(Object.keys(readBindings(root)), ['b']);
		assert.equal(clearBinding(root, 'a'), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('the bindings file is written privately and atomically', () => {
	const root = tempRoot();
	try {
		writeBinding(root, 'peer', { sessionId: 'session-1' });
		if (process.platform !== 'win32') {
			assert.equal(statSync(bindingsPath(root)).mode & 0o777, 0o600);
		}
		assert.deepEqual(readdirSync(root).filter((entry) => entry.endsWith('.tmp')), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('the inbound cursor and duplicate window round-trip together', () => {
	const root = tempRoot();
	try {
		assert.deepEqual(readChannelState(root), { cursor: '', seenIds: [], inflight: undefined, lastReplyError: '', updatedAt: 0 });
		writeChannelState(root, { cursor: 'buf-1', seenIds: ['m-1', 'm-2'] });
		const state = readChannelState(root);
		assert.equal(state.cursor, 'buf-1');
		assert.deepEqual(state.seenIds, ['m-1', 'm-2']);
		assert.equal(state.updatedAt > 0, true);
		/* A later write replaces both halves in one document. */
		writeChannelState(root, { cursor: 'buf-2', seenIds: ['m-3'] });
		assert.deepEqual(readChannelState(root).seenIds, ['m-3']);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('an unconfirmed submission and the last reply failure survive a restart', () => {
	const root = tempRoot();
	try {
		writeChannelState(root, {
			cursor: 'c',
			seenIds: [],
			inflight: { messageId: 'weixin-m-9', requestId: 'weixin-m-9', sessionId: 'session-1', text: '跑测试', at: 5, state: 'submitting' },
			lastReplyError: 'context expired',
		});
		const state = readChannelState(root);
		assert.deepEqual(state.inflight, {
			messageId: 'weixin-m-9', requestId: 'weixin-m-9', sessionId: 'session-1', text: '跑测试', at: 5, state: 'submitting',
		});
		assert.equal(state.lastReplyError, 'context expired');
		/* Clearing the marker writes it away in the same document. */
		writeChannelState(root, { cursor: 'c', seenIds: [] });
		assert.equal(readChannelState(root).inflight, undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('an unusable in-flight record is dropped rather than half-honoured', () => {
	const root = tempRoot();
	try {
		writeChannelState(root, { cursor: '', seenIds: [], inflight: { messageId: 'm', requestId: '', sessionId: 's' } });
		assert.equal(readChannelState(root).inflight, undefined);
		writeChannelState(root, { cursor: '', seenIds: [], inflight: { messageId: 'm', requestId: 'r', sessionId: 's', state: 'weird' } });
		assert.equal(readChannelState(root).inflight.state, 'submitting', 'an unknown state degrades to the safe default');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('a damaged channel state reads as fresh rather than partially trusted', () => {
	const root = tempRoot();
	try {
		writeFileSync(channelStatePath(root), 'not json', 'utf8');
		assert.equal(readChannelState(root).cursor, '');
		writeFileSync(channelStatePath(root), JSON.stringify({ version: 42, cursor: 'x', seenIds: ['a'] }), 'utf8');
		assert.deepEqual(readChannelState(root).seenIds, [], 'a foreign version must not be interpreted');
		writeFileSync(channelStatePath(root), JSON.stringify({ version: 1, cursor: 5, seenIds: ['ok', 7, ''] }), 'utf8');
		const state = readChannelState(root);
		assert.equal(state.cursor, '', 'a non-string cursor is not trusted');
		assert.deepEqual(state.seenIds, ['ok']);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('the channel state file is private and leaves no temporary file', () => {
	const root = tempRoot();
	try {
		writeChannelState(root, { cursor: 'c', seenIds: [] });
		if (process.platform !== 'win32') {
			assert.equal(statSync(channelStatePath(root)).mode & 0o777, 0o600);
		}
		assert.deepEqual(readdirSync(root).filter((entry) => entry.endsWith('.tmp')), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
