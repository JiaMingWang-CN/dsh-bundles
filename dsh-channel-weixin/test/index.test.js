import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply, inject, name, testing } from '../lib/index.js';

/** Every status field the page may see; a new field must be added here on purpose. */
const PUBLIC_FIELDS = [
	'account', 'boundCwd', 'boundSession', 'lastError', 'loginExpiresAt', 'model',
	'ok', 'phase', 'queueCount', 'scheduleCount', 'updatedAt', 'verifyCodeRequired',
];

/** Run one plugin instance against a recording context and a throwaway storage root. */
function mount({ env, services = {}, onCalls } = {}) {
	const previousHome = process.env.DSH_HOME;
	const root = mkdtempSync(join(tmpdir(), 'channel-weixin-host-'));
	process.env.DSH_HOME = env ?? root;
	const routes = [];
	const disposers = [];
	const subscriptions = [];
	const ctx = {
		webServer: { register: (route) => { routes.push(route); return () => routes.splice(routes.indexOf(route), 1); } },
		effect: (callback) => { disposers.push(callback()); },
		get: (name) => services[name],
		on: (event, handler) => {
			subscriptions.push({ event, handler });
			if (onCalls !== undefined) onCalls.push(event);
			return () => subscriptions.splice(subscriptions.findIndex((entry) => entry.handler === handler), 1);
		},
	};
	apply(ctx);
	return {
		route: routes[0],
		routes,
		subscriptions,
		emit(event, ...args) {
			for (const entry of subscriptions) if (entry.event === event) entry.handler(...args);
		},
		dispose() {
			for (const dispose of disposers) dispose();
			if (previousHome === undefined) delete process.env.DSH_HOME;
			else process.env.DSH_HOME = previousHome;
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** A request stand-in: headers, method, url, and an async body iterator. */
function fakeRequest({ method = 'GET', url = '/', headers = {}, body } = {}) {
	const payload = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')];
	return {
		method,
		url,
		headers,
		async *[Symbol.asyncIterator]() {
			for (const chunk of payload) yield chunk;
		},
	};
}

/** A response stand-in resolving when the handler ends the response. */
function fakeResponse() {
	const state = { statusCode: 0, headers: {}, body: '' };
	const done = Promise.withResolvers();
	const response = {
		get statusCode() { return state.statusCode; },
		set statusCode(value) { state.statusCode = value; },
		setHeader: (key, value) => { state.headers[key] = value; },
		end: (body) => { state.body = body ?? ''; done.resolve(); },
	};
	return {
		response,
		done: done.promise,
		get body() { return state.body; },
		get json() { return state.body === '' ? undefined : JSON.parse(state.body); },
		get statusCode() { return state.statusCode; },
		get headers() { return state.headers; },
	};
}

/** One round trip through the mounted prefix route. */
async function call(route, request) {
	const res = fakeResponse();
	await route.handler(request, res.response);
	await res.done;
	return res;
}

/** Headers a same-origin page request carries. */
const PAGE_HEADERS = {
	'x-dsh-weixin': '1',
	'sec-fetch-site': 'same-origin',
	origin: 'http://127.0.0.1:3080',
	'content-type': 'application/json',
};

test('the host half declares a stable plugin identity', () => {
	assert.equal(name, 'channel-weixin');
	assert.deepEqual(inject, ['webServer']);
	assert.equal(typeof apply, 'function');
});

test('the plugin owns a prefix route and a poll-timer effect', () => {
	const mounted = mount();
	try {
		assert.equal(mounted.routes.length, 1);
		assert.equal(mounted.route.kind, 'prefix');
		assert.equal(mounted.route.path, testing.ROUTE_PREFIX);
	} finally {
		mounted.dispose();
	}
});

test('a fresh snapshot starts stopped and unbound', () => {
	const status = testing.createStatus();
	assert.equal(status.phase, 'stopped');
	assert.equal(status.account, '');
	assert.equal(status.verifyCodeRequired, false);
	assert.equal(status.loginExpiresAt, 0);
});

test('the published projection masks the account identity', () => {
	const status = { ...testing.createStatus(), phase: 'connected', account: 'wxid_abcdefgh1234' };
	const published = testing.publicStatus(status, 1);
	assert.equal(published.account, '****1234');
	assert.equal(published.account.includes('wxid_'), false);
});

test('a short account identity never leaks a full value', () => {
	assert.equal(testing.maskAccount('abcd'), '****');
	assert.equal(testing.maskAccount(''), '');
	assert.equal(testing.maskAccount(undefined), '');
});

test('the projection is a whitelist: an unknown snapshot field never reaches the page', () => {
	const status = {
		...testing.createStatus(),
		phase: 'connected',
		token: 'bot-token-secret',
		contextToken: 'context-token-secret',
		verifyCode: '123456',
		qrcode: 'qrcode-secret',
		qrPayload: 'https://weixin.qq.com/x/secret',
	};
	const wire = JSON.stringify(testing.publicStatus(status, 1));
	for (const secret of ['bot-token-secret', 'context-token-secret', '123456', 'qrcode-secret', 'x/secret']) {
		assert.equal(wire.includes(secret), false, `published payload leaked ${secret}`);
	}
	assert.deepEqual(Object.keys(testing.publicStatus(status, 1)).sort(), PUBLIC_FIELDS);
});

test('an unknown phase degrades to error instead of reaching the page verbatim', () => {
	const published = testing.publicStatus({ ...testing.createStatus(), phase: 'not-a-phase' }, 1);
	assert.equal(published.phase, 'error');
	assert.deepEqual([...testing.PHASES], [
		'stopped', 'login-pending', 'scanned', 'verify-required', 'connected', 'error',
	]);
});

test('long text and hostile counts are bounded in the published payload', () => {
	const status = {
		...testing.createStatus(),
		phase: 'error',
		lastError: 'x'.repeat(1000),
		queueCount: -3,
		scheduleCount: Number.NaN,
	};
	const published = testing.publicStatus(status, 1);
	assert.equal(published.lastError.length, 300);
	assert.equal(published.queueCount, 0);
	assert.equal(published.scheduleCount, 0);
});

test('the status route answers JSON and rejects writers', async () => {
	const mounted = mount();
	try {
		const read = await call(mounted.route, fakeRequest({ url: testing.STATUS_PATH }));
		assert.equal(read.statusCode, 200);
		assert.equal(read.headers['content-type'], 'application/json; charset=utf-8');
		assert.equal(read.headers['cache-control'], 'no-store');
		assert.equal(read.json.ok, true);
		assert.equal(read.json.phase, 'stopped');
		const write = await call(mounted.route, fakeRequest({ method: 'POST', url: testing.STATUS_PATH }));
		assert.equal(write.statusCode, 405);
		assert.equal(write.json.reason, 'method-not-allowed');
	} finally {
		mounted.dispose();
	}
});

test('the QR endpoint publishes no scannable payload and no QR while idle', async () => {
	const mounted = mount();
	try {
		const res = await call(mounted.route, fakeRequest({ url: testing.LOGIN_QR_PATH }));
		assert.equal(res.statusCode, 200);
		assert.equal(res.json.qrAvailable, false);
		assert.equal(res.json.qrRevision, 0);
		assert.equal(res.body.includes('qrPayload'), false);
	} finally {
		mounted.dispose();
	}
});

test('the QR image endpoint answers 404 while no login is pending', async () => {
	const mounted = mount();
	try {
		const res = await call(mounted.route, fakeRequest({ url: testing.LOGIN_QR_SVG_PATH }));
		assert.equal(res.statusCode, 404);
		assert.equal(res.json.reason, 'no-pending-qr');
	} finally {
		mounted.dispose();
	}
});

test('an untrusted caller cannot start a login or log out', async () => {
	const mounted = mount();
	try {
		for (const url of [testing.LOGIN_START_PATH, testing.LOGIN_CANCEL_PATH, testing.LOGOUT_PATH]) {
			const res = await call(mounted.route, fakeRequest({ method: 'POST', url, headers: { 'content-type': 'application/json' }, body: {} }));
			assert.equal(res.statusCode, 403, `${url} accepted an unguarded request`);
			assert.equal(res.json.reason, 'untrusted-request');
		}
	} finally {
		mounted.dispose();
	}
});

test('a foreign Origin is refused even with the plugin header', async () => {
	const mounted = mount();
	try {
		const res = await call(mounted.route, fakeRequest({
			method: 'POST',
			url: testing.LOGOUT_PATH,
			headers: { 'x-dsh-weixin': '1', origin: 'http://evil.example.com', 'content-type': 'application/json' },
			body: {},
		}));
		assert.equal(res.statusCode, 403);
	} finally {
		mounted.dispose();
	}
});

test('a cross-site fetch site is refused', () => {
	assert.equal(testing.isTrustedPageRequest({ headers: { 'x-dsh-weixin': '1', 'sec-fetch-site': 'cross-site' } }), false);
	assert.equal(testing.isTrustedPageRequest({ headers: { 'x-dsh-weixin': '0' } }), false);
	assert.equal(testing.isTrustedPageRequest({ headers: {} }), false);
	assert.equal(testing.isTrustedPageRequest({ headers: { 'x-dsh-weixin': '1' } }), true);
	assert.equal(testing.isTrustedPageRequest({
		headers: { 'x-dsh-weixin': '1', origin: 'http://localhost:3080' },
	}), true);
	assert.equal(testing.isTrustedPageRequest({
		headers: { 'x-dsh-weixin': '1', origin: 'not a url' },
	}), false);
});

test('an unknown sub-path under the plugin prefix is a 404', async () => {
	const mounted = mount();
	try {
		const res = await call(mounted.route, fakeRequest({ method: 'POST', url: testing.ROUTE_PREFIX + '/nope', headers: PAGE_HEADERS, body: {} }));
		assert.equal(res.statusCode, 404);
		assert.equal(res.json.reason, 'not-found');
	} finally {
		mounted.dispose();
	}
});

test('a guarded verify request without an active login is rejected, not silently accepted', async () => {
	const mounted = mount();
	try {
		const res = await call(mounted.route, fakeRequest({
			method: 'POST', url: testing.LOGIN_VERIFY_PATH, headers: PAGE_HEADERS, body: { code: '1234' },
		}));
		assert.equal(res.statusCode, 400);
		assert.equal(res.json.reason, 'invalid-or-inactive-code');
	} finally {
		mounted.dispose();
	}
});

test('logout clears a stored credential and returns to stopped', async () => {
	const { writeAccount } = await import('../lib/storage.js');
	const home = mkdtempSync(join(tmpdir(), 'channel-weixin-home-'));
	writeAccount(join(home, 'storages', 'channel-weixin'), {
		botToken: 'tok', baseUrl: 'https://weixin.qq.com', botId: 'bot-1', userId: 'user-1',
	});
	const mounted = mount({ env: home });
	try {
		const before = await call(mounted.route, fakeRequest({ url: testing.STATUS_PATH }));
		assert.equal(before.json.phase, 'connected');
		const res = await call(mounted.route, fakeRequest({ method: 'POST', url: testing.LOGOUT_PATH, headers: PAGE_HEADERS, body: {} }));
		assert.equal(res.statusCode, 200);
		assert.equal(res.json.status.phase, 'stopped');
		assert.equal(res.json.status.account, '');
		const after = await call(mounted.route, fakeRequest({ url: testing.STATUS_PATH }));
		assert.equal(after.json.phase, 'stopped');
	} finally {
		mounted.dispose();
		rmSync(home, { recursive: true, force: true });
	}
});

test('a stored credential is adopted at mount without exposing the token', async () => {
	const { writeAccount } = await import('../lib/storage.js');
	const home = mkdtempSync(join(tmpdir(), 'channel-weixin-home-'));
	writeAccount(join(home, 'storages', 'channel-weixin'), {
		botToken: 'very-secret-token', baseUrl: 'https://weixin.qq.com', botId: 'bot-1', userId: 'user-123456',
	});
	const mounted = mount({ env: home });
	try {
		const res = await call(mounted.route, fakeRequest({ url: testing.STATUS_PATH }));
		assert.equal(res.json.phase, 'connected');
		assert.equal(res.json.account, '****3456');
		assert.equal(res.body.includes('very-secret-token'), false);
	} finally {
		mounted.dispose();
		rmSync(home, { recursive: true, force: true });
	}
});

test('the status route publishes the binding and schedule counts it promises', async () => {
	const { writeAccount, writeBinding, writeSchedules } = await import('../lib/storage.js');
	const home = mkdtempSync(join(tmpdir(), 'channel-weixin-published-'));
	const store = join(home, 'storages', 'channel-weixin');
	writeAccount(store, { botToken: 'tok', baseUrl: 'https://weixin.qq.com', botId: 'bot-1', userId: 'user-1' });
	writeBinding(store, 'user-1', { sessionId: 'session-abcdef12', cwd: 'C:\\work', model: 'alpha/a1' });
	writeSchedules(store, {
		nextId: 3,
		entries: [
			{ id: 'sched-1', peer: 'user-1', sessionId: 'session-abcdef12', text: 'a', kind: 'once', at: 1, nextAt: 1 },
			{ id: 'sched-2', peer: 'user-1', sessionId: 'session-abcdef12', text: 'b', kind: 'every', everyMs: 1000, at: 1, nextAt: 1 },
		],
	});
	const mounted = mount({ env: home, services: { agents: { get: () => undefined, resume: async () => {}, roots: () => [] } } });
	try {
		const res = await call(mounted.route, fakeRequest({ url: testing.STATUS_PATH }));
		assert.equal(res.json.boundSession, 'session-abcdef12');
		assert.equal(res.json.boundCwd, 'C:\\work');
		assert.equal(res.json.model, 'alpha/a1');
		assert.equal(res.json.scheduleCount, 2);
	} finally {
		mounted.dispose();
		rmSync(home, { recursive: true, force: true });
	}
});

test('a fresh install publishes no binding instead of stale values', async () => {
	const mounted = mount();
	try {
		const res = await call(mounted.route, fakeRequest({ url: testing.STATUS_PATH }));
		assert.equal(res.json.boundSession, '');
		assert.equal(res.json.boundCwd, '');
		assert.equal(res.json.scheduleCount, 0);
	} finally {
		mounted.dispose();
	}
});

test('a slow confirmation from a superseded login is discarded', async (t) => {
	t.mock.timers.enable({ apis: ['setInterval'] });
	const realFetch = globalThis.fetch;
	const { readAccount } = await import('../lib/storage.js');
	let qrCount = 0;
	const pending = [];
	globalThis.fetch = async (url) => {
		if (String(url).includes('get_bot_qrcode')) {
			qrCount += 1;
			const body = { qrcode: `poll-secret-${qrCount}`, qrcode_img_content: `https://weixin.qq.com/x/qr-${qrCount}` };
			return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
		}
		/* Status polls hang until the test releases them. */
		const deferred = Promise.withResolvers();
		pending.push(deferred);
		return deferred.promise;
	};
	const home = mkdtempSync(join(tmpdir(), 'channel-weixin-race-'));
	const mounted = mount({ env: home });
	try {
		await call(mounted.route, fakeRequest({ method: 'POST', url: testing.LOGIN_START_PATH, headers: PAGE_HEADERS, body: {} }));
		t.mock.timers.tick(1000);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(pending.length, 1, 'the first generation starts one poll');
		/* A second scan request replaces the attempt while the old poll is in flight. */
		await call(mounted.route, fakeRequest({ method: 'POST', url: testing.LOGIN_START_PATH, headers: PAGE_HEADERS, body: {} }));
		const qr = await call(mounted.route, fakeRequest({ url: testing.LOGIN_QR_PATH }));
		assert.equal(qr.json.qrRevision >= 2, true, 'the page sees the new QR');
		/* The superseded poll now answers "confirmed" — it must be ignored. */
		pending[0].resolve({
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ status: 'confirmed', bot_token: 'stale-token', ilink_user_id: 'user-1' }),
			json: async () => ({ status: 'confirmed', bot_token: 'stale-token', ilink_user_id: 'user-1' }),
		});
		for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
		const status = await call(mounted.route, fakeRequest({ url: testing.STATUS_PATH }));
		assert.notEqual(status.json.phase, 'connected', 'a superseded confirmation must not connect');
		assert.equal(status.json.account, '');
		assert.equal(readAccount(join(home, 'storages', 'channel-weixin')), null, 'no credential may be written from a superseded attempt');
	} finally {
		globalThis.fetch = realFetch;
		mounted.dispose();
		t.mock.timers.reset();
		rmSync(home, { recursive: true, force: true });
	}
});

test('cancelling a login discards a late confirmation too', async (t) => {
	t.mock.timers.enable({ apis: ['setInterval'] });
	const realFetch = globalThis.fetch;
	const { readAccount } = await import('../lib/storage.js');
	const pending = [];
	globalThis.fetch = async (url) => {
		if (String(url).includes('get_bot_qrcode')) {
			const body = { qrcode: 'poll-secret', qrcode_img_content: 'https://weixin.qq.com/x/qr' };
			return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
		}
		const deferred = Promise.withResolvers();
		pending.push(deferred);
		return deferred.promise;
	};
	const home = mkdtempSync(join(tmpdir(), 'channel-weixin-cancel-race-'));
	const mounted = mount({ env: home });
	try {
		await call(mounted.route, fakeRequest({ method: 'POST', url: testing.LOGIN_START_PATH, headers: PAGE_HEADERS, body: {} }));
		t.mock.timers.tick(1000);
		await new Promise((resolve) => setImmediate(resolve));
		await call(mounted.route, fakeRequest({ method: 'POST', url: testing.LOGIN_CANCEL_PATH, headers: PAGE_HEADERS, body: {} }));
		pending[0].resolve({
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ status: 'confirmed', bot_token: 'stale-token' }),
			json: async () => ({ status: 'confirmed', bot_token: 'stale-token' }),
		});
		for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
		const status = await call(mounted.route, fakeRequest({ url: testing.STATUS_PATH }));
		assert.equal(status.json.phase, 'stopped');
		assert.equal(readAccount(join(home, 'storages', 'channel-weixin')), null);
	} finally {
		globalThis.fetch = realFetch;
		mounted.dispose();
		t.mock.timers.reset();
		rmSync(home, { recursive: true, force: true });
	}
});

test('an over-long QR payload is reported as a reason, not a broken image', async (t) => {
	t.mock.timers.enable({ apis: ['setInterval'] });
	const realFetch = globalThis.fetch;
	/* A payload beyond what version 10 at the most permissive level can hold. */
	const huge = 'https://weixin.qq.com/x/' + 'a'.repeat(500);
	globalThis.fetch = async (url) => {
		const body = String(url).includes('get_bot_qrcode')
			? { qrcode: 'poll-secret', qrcode_img_content: huge }
			: { status: 'wait' };
		return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
	};
	const home = mkdtempSync(join(tmpdir(), 'channel-weixin-hugeqr-'));
	const mounted = mount({ env: home });
	try {
		const started = await call(mounted.route, fakeRequest({ method: 'POST', url: testing.LOGIN_START_PATH, headers: PAGE_HEADERS, body: {} }));
		assert.equal(started.json.status.phase, 'login-pending');
		const svg = await call(mounted.route, fakeRequest({ url: testing.LOGIN_QR_SVG_PATH }));
		assert.equal(svg.statusCode, 422);
		assert.equal(svg.json.reason, 'qr-too-long');
		assert.equal(svg.body.includes('data:image'), false, 'no half-rendered image may be returned');
	} finally {
		globalThis.fetch = realFetch;
		mounted.dispose();
		t.mock.timers.reset();
		rmSync(home, { recursive: true, force: true });
	}
});

test('reconnect resumes receiving with the stored credential, without a new scan', async () => {
	const { writeAccount, readAccount } = await import('../lib/storage.js');
	const home = mkdtempSync(join(tmpdir(), 'channel-weixin-reconnect-'));
	writeAccount(join(home, 'storages', 'channel-weixin'), {
		botToken: 'tok', baseUrl: 'https://weixin.qq.com', botId: 'bot-1', userId: 'user-1',
	});
	const calls = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		return { ok: true, status: 200, text: async () => JSON.stringify({ ret: 0, msgs: [], get_updates_buf: '' }) };
	};
	const mounted = mount({ env: home, services: { agents: { get: () => undefined, resume: async () => {}, roots: () => [] } } });
	try {
		/* Disconnect first: receiving stops but the credential stays. */
		const disconnected = await call(mounted.route, fakeRequest({ method: 'POST', url: testing.DISCONNECT_PATH, headers: PAGE_HEADERS, body: {} }));
		assert.equal(disconnected.json.status.phase, 'stopped');
		assert.notEqual(readAccount(join(home, 'storages', 'channel-weixin')), null);
		calls.length = 0;
		const reconnected = await call(mounted.route, fakeRequest({ method: 'POST', url: testing.RECONNECT_PATH, headers: PAGE_HEADERS, body: {} }));
		assert.equal(reconnected.statusCode, 200);
		assert.equal(reconnected.json.status.phase, 'connected');
		assert.equal(reconnected.json.status.account, '****er-1');
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(calls.some((url) => url.includes('getupdates')), true, 'reconnecting must start receiving again');
	} finally {
		mounted.dispose();
		globalThis.fetch = realFetch;
		rmSync(home, { recursive: true, force: true });
	}
});

test('reconnect without a credential says so instead of pretending to connect', async () => {
	const mounted = mount({ services: { agents: { get: () => undefined, resume: async () => {}, roots: () => [] } } });
	try {
		const res = await call(mounted.route, fakeRequest({ method: 'POST', url: testing.RECONNECT_PATH, headers: PAGE_HEADERS, body: {} }));
		assert.equal(res.statusCode, 400);
		assert.equal(res.json.reason, 'no-credential');
	} finally {
		mounted.dispose();
	}
});

test('reconnect without the session service reports that instead of failing silently', async () => {
	const { writeAccount } = await import('../lib/storage.js');
	const home = mkdtempSync(join(tmpdir(), 'channel-weixin-reconnect-nosvc-'));
	writeAccount(join(home, 'storages', 'channel-weixin'), {
		botToken: 'tok', baseUrl: 'https://weixin.qq.com', botId: 'bot-1', userId: 'user-1',
	});
	const mounted = mount({ env: home });
	try {
		const res = await call(mounted.route, fakeRequest({ method: 'POST', url: testing.RECONNECT_PATH, headers: PAGE_HEADERS, body: {} }));
		assert.equal(res.statusCode, 400);
		assert.equal(res.json.reason, 'agents-unavailable');
	} finally {
		mounted.dispose();
		rmSync(home, { recursive: true, force: true });
	}
});

test('reconnect is a guarded mutation like the other control endpoints', async () => {
	const mounted = mount({ services: { agents: { get: () => undefined, resume: async () => {}, roots: () => [] } } });
	try {
		const res = await call(mounted.route, fakeRequest({ method: 'POST', url: testing.RECONNECT_PATH, headers: { 'content-type': 'application/json' }, body: {} }));
		assert.equal(res.statusCode, 403);
	} finally {
		mounted.dispose();
	}
});

test('logout removes the account schedules even when the connection was already closed', async () => {
	const { writeAccount, writeSchedules, readSchedules } = await import('../lib/storage.js');
	const home = mkdtempSync(join(tmpdir(), 'channel-weixin-logout-sched-'));
	const store = join(home, 'storages', 'channel-weixin');
	writeAccount(store, { botToken: 'tok', baseUrl: 'https://weixin.qq.com', botId: 'bot-1', userId: 'user-1' });
	writeSchedules(store, {
		nextId: 3,
		entries: [
			{ id: 'sched-mine', peer: 'user-1', sessionId: 'session-1', text: 'a', kind: 'once', at: 1, nextAt: 1, timeZone: 't', createdAt: 1, sequence: 0, runs: 0, missed: 0, lastOutcome: '', lastRunAt: 0 },
			{ id: 'sched-other', peer: 'user-2', sessionId: 'session-2', text: 'b', kind: 'once', at: 1, nextAt: 1, timeZone: 't', createdAt: 1, sequence: 0, runs: 0, missed: 0, lastOutcome: '', lastRunAt: 0 },
		],
	});
	const mounted = mount({ env: home });
	try {
		/* Disconnect first, so no loop is mounted when the logout happens. */
		await call(mounted.route, fakeRequest({ method: 'POST', url: testing.DISCONNECT_PATH, headers: PAGE_HEADERS, body: {} }));
		const res = await call(mounted.route, fakeRequest({ method: 'POST', url: testing.LOGOUT_PATH, headers: PAGE_HEADERS, body: {} }));
		assert.equal(res.statusCode, 200);
		assert.deepEqual(readSchedules(store).entries.map((entry) => entry.id), ['sched-other']);
	} finally {
		mounted.dispose();
		rmSync(home, { recursive: true, force: true });
	}
});

test('the published model follows the live session, not a stale stored value', async () => {
	const { writeAccount, writeBinding } = await import('../lib/storage.js');
	const home = mkdtempSync(join(tmpdir(), 'channel-weixin-model-'));
	const store = join(home, 'storages', 'channel-weixin');
	writeAccount(store, { botToken: 'tok', baseUrl: 'https://weixin.qq.com', botId: 'bot-1', userId: 'user-1' });
	writeBinding(store, 'user-1', { sessionId: 'session-1', cwd: 'C:\\w', model: 'stale/old' });
	const projections = { stateOf: () => ({ pending: { provider: 'alpha', model: 'a1' }, lastUsed: { provider: 'beta', model: 'b1' } }) };
	const mounted = mount({
		env: home,
		services: {
			agents: { get: () => ({ session: { id: 'session-1' } }), resume: async () => {}, roots: () => [] },
			sessionProjections: projections,
		},
	});
	try {
		const res = await call(mounted.route, fakeRequest({ url: testing.STATUS_PATH }));
		assert.equal(res.json.model, 'alpha/a1', 'the pending selection wins over the last used route');
	} finally {
		mounted.dispose();
		rmSync(home, { recursive: true, force: true });
	}
});

test('the published model falls back cleanly when nothing can be read', async () => {
	const { writeAccount, writeBinding } = await import('../lib/storage.js');
	const home = mkdtempSync(join(tmpdir(), 'channel-weixin-model-fallback-'));
	const store = join(home, 'storages', 'channel-weixin');
	writeAccount(store, { botToken: 'tok', baseUrl: 'https://weixin.qq.com', botId: 'bot-1', userId: 'user-1' });
	writeBinding(store, 'user-1', { sessionId: 'session-1', cwd: 'C:\\w', model: 'stored/value' });
	/* No session service mounted at all: the stored value is the best available. */
	const mounted = mount({ env: home });
	try {
		const res = await call(mounted.route, fakeRequest({ url: testing.STATUS_PATH }));
		assert.equal(res.json.model, 'stored/value');
	} finally {
		mounted.dispose();
		rmSync(home, { recursive: true, force: true });
	}
	/* A live session with no selection and a throwing projection both stay empty. */
	const home2 = mkdtempSync(join(tmpdir(), 'channel-weixin-model-empty-'));
	const store2 = join(home2, 'storages', 'channel-weixin');
	writeAccount(store2, { botToken: 'tok', baseUrl: 'https://weixin.qq.com', botId: 'bot-1', userId: 'user-1' });
	writeBinding(store2, 'user-1', { sessionId: 'session-1' });
	const empty = mount({
		env: home2,
		services: {
			agents: { get: () => ({ session: { id: 'session-1' } }), resume: async () => {}, roots: () => [] },
			sessionProjections: { stateOf: () => undefined },
		},
	});
	try {
		assert.equal((await call(empty.route, fakeRequest({ url: testing.STATUS_PATH }))).json.model, '');
	} finally {
		empty.dispose();
		rmSync(home2, { recursive: true, force: true });
	}
	const home3 = mkdtempSync(join(tmpdir(), 'channel-weixin-model-throw-'));
	const store3 = join(home3, 'storages', 'channel-weixin');
	writeAccount(store3, { botToken: 'tok', baseUrl: 'https://weixin.qq.com', botId: 'bot-1', userId: 'user-1' });
	writeBinding(store3, 'user-1', { sessionId: 'session-1' });
	const throwing = mount({
		env: home3,
		services: {
			agents: { get: () => ({ session: { id: 'session-1' } }), resume: async () => {}, roots: () => [] },
			sessionProjections: { stateOf: () => { throw new Error('registry gone'); } },
		},
	});
	try {
		assert.equal((await call(throwing.route, fakeRequest({ url: testing.STATUS_PATH }))).json.model, '', 'a failing projection must not break the status route');
	} finally {
		throwing.dispose();
		rmSync(home3, { recursive: true, force: true });
	}
});

test('a service mounted after the loop starts is picked up by the next command', async () => {
	const { writeAccount, writeBinding } = await import('../lib/storage.js');
	const home = mkdtempSync(join(tmpdir(), 'channel-weixin-late-service-'));
	const store = join(home, 'storages', 'channel-weixin');
	writeAccount(store, { botToken: 'tok', baseUrl: 'https://weixin.qq.com', botId: 'bot-1', userId: 'user-1' });
	writeBinding(store, 'user-1', { sessionId: 'session-1', cwd: 'C:\\w' });
	const sent = [];
	const queue = [];
	let delivered = 0;
	let polls = 0;
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		const target = String(url);
		if (target.includes('getupdates')) {
			polls += 1;
			/* Messages are delivered only when the test queues one, so the timing of a
			 * service appearing is controlled rather than raced against the poll loop. */
			const next = queue.shift();
			const body = next === undefined
				? { ret: 0, msgs: [], get_updates_buf: `cursor-${delivered}` }
				: { ret: 0, msgs: [next], get_updates_buf: `cursor-${delivered += 1}` };
			return {
				ok: true,
				status: 200,
				text: async () => JSON.stringify(body),
				/* Polling the stub always behaves like a long poll that timed out. */
				timedOut: next === undefined,
			};
		}
		if (target.includes('sendmessage')) {
			sent.push(JSON.parse(init.body).msg.item_list[0].text_item.text);
			return { ok: true, status: 200, text: async () => JSON.stringify({ ret: 0, message_id: '1' }) };
		}
		if (target.includes('getconfig')) {
			return { ok: true, status: 200, text: async () => JSON.stringify({ ret: 0, typing_ticket: 'tk' }) };
		}
		return { ok: true, status: 200, text: async () => JSON.stringify({ ret: 0 }) };
	};
	/** One inbound command message from the bound user. */
	const command = (id) => ({
		message_id: id,
		from_user_id: 'user-1',
		message_type: 1,
		create_time_ms: Date.now(),
		item_list: [{ type: 1, text_item: { text: '/models' } }],
	});
	const services = {
		agents: { get: () => ({ status: 'idle', inbox: { nextTurn: [], nextStep: [], remove: () => true }, cancel: () => {}, session: {} }), resume: async () => {}, roots: () => [] },
	};
	const mounted = mount({ env: home, services });
	try {
		assert.equal(await waitFor(() => polls >= 1), true, 'the initial cursor baseline was not established');
		queue.push(command('m-1'));
		assert.equal(await waitFor(() => sent.length >= 1), true, `no reply arrived; sent=${JSON.stringify(sent)}`);
		assert.match(sent[0], /没有可用的模型服务/);
		/* Mount the service the loop was constructed without, then send again. */
		services.llm = { listProviders: () => [{ id: 'alpha', name: 'Alpha' }], listModels: async () => [{ id: 'a1' }] };
		queue.push(command('m-2'));
		assert.equal(await waitFor(() => sent.length >= 2), true, `the second reply never arrived; sent=${JSON.stringify(sent)}`);
		assert.match(sent[1], /Alpha（alpha）/, 'a later-mounted service must be visible without a restart');
		assert.match(sent[1], /a1/);
	} finally {
		mounted.dispose();
		globalThis.fetch = realFetch;
		rmSync(home, { recursive: true, force: true });
	}
});

/** Wait (bounded, on the macrotask queue) until `check()` holds. */
async function waitFor(check, attempts = 200) {
	for (let index = 0; index < attempts; index += 1) {
		if (check()) return true;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return false;
}

test('disposing the plugin unregisters the route', () => {
	const mounted = mount();
	try {
		assert.equal(mounted.routes.length, 1);
	} finally {
		mounted.dispose();
	}
	assert.equal(mounted.routes.length, 0);
});

test('the plugin subscribes to the four attribution inputs and unwinds them', () => {
	const mounted = mount();
	try {
		const events = mounted.subscriptions.map((entry) => entry.event).sort();
		assert.deepEqual(events, ['agent/assistant-stream', 'agent/error', 'agent/inbox/claimed', 'session/event']);
	} finally {
		mounted.dispose();
	}
	assert.deepEqual(mounted.subscriptions, []);
});

test('no channel loop is started without a credential', async () => {
	const calls = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error('network must not be touched'); };
	try {
		const mounted = mount({ services: { agents: { get: () => undefined, resume: async () => {}, roots: () => [] } } });
		try {
			await new Promise((resolve) => setImmediate(resolve));
			assert.deepEqual(calls, [], 'without credentials the plugin must not poll the server');
		} finally {
			mounted.dispose();
		}
	} finally {
		globalThis.fetch = realFetch;
	}
});

test('a stored credential starts receiving, and disposal stops it', async () => {
	const { writeAccount } = await import('../lib/storage.js');
	const home = mkdtempSync(join(tmpdir(), 'channel-weixin-loop-home-'));
	writeAccount(join(home, 'storages', 'channel-weixin'), {
		botToken: 'tok', baseUrl: 'https://weixin.qq.com', botId: 'bot-1', userId: 'user-1',
	});
	const calls = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		return { ok: true, status: 200, text: async () => JSON.stringify({ ret: 0, msgs: [], get_updates_buf: '' }) };
	};
	const mounted = mount({ env: home, services: { agents: { get: () => undefined, resume: async () => {}, roots: () => [] } } });
	try {
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(calls.some((url) => url.includes('getupdates')), true, 'a stored credential must begin polling');
	} finally {
		mounted.dispose();
		globalThis.fetch = realFetch;
		rmSync(home, { recursive: true, force: true });
	}
});

test('disconnect stops receiving but keeps the credential', async () => {
	const { writeAccount, readAccount } = await import('../lib/storage.js');
	const home = mkdtempSync(join(tmpdir(), 'channel-weixin-disconnect-'));
	writeAccount(join(home, 'storages', 'channel-weixin'), {
		botToken: 'tok', baseUrl: 'https://weixin.qq.com', botId: 'bot-1', userId: 'user-1',
	});
	const realFetch = globalThis.fetch;
	globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ret: 0, msgs: [], get_updates_buf: '' }) });
	const mounted = mount({ env: home, services: { agents: { get: () => undefined, resume: async () => {}, roots: () => [] } } });
	try {
		const res = await call(mounted.route, fakeRequest({ method: 'POST', url: testing.DISCONNECT_PATH, headers: PAGE_HEADERS, body: {} }));
		assert.equal(res.statusCode, 200);
		assert.equal(res.json.status.phase, 'stopped');
		assert.equal(res.json.status.account, '****er-1', 'the account label survives a disconnect');
		assert.notEqual(readAccount(join(home, 'storages', 'channel-weixin')), null, 'disconnect must keep the credential');
	} finally {
		mounted.dispose();
		globalThis.fetch = realFetch;
		rmSync(home, { recursive: true, force: true });
	}
});

test('a confirmed login persists the credential through the route flow', async (t) => {
	t.mock.timers.enable({ apis: ['setInterval'] });
	const realFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url, options) => {
		calls.push({ url: String(url), options });
		const body = String(url).includes('get_bot_qrcode')
			? { qrcode: 'poll-secret', qrcode_img_content: 'https://weixin.qq.com/x/scan-me' }
			: { status: 'confirmed', bot_token: 'saved-token', ilink_bot_id: 'bot-7', ilink_user_id: 'user-7777' };
		return {
			ok: true,
			status: 200,
			text: async () => JSON.stringify(body),
			json: async () => body,
		};
	};
	const mounted = mount();
	try {
		const started = await call(mounted.route, fakeRequest({ method: 'POST', url: testing.LOGIN_START_PATH, headers: PAGE_HEADERS, body: {} }));
		assert.equal(started.statusCode, 200);
		assert.equal(started.json.status.phase, 'login-pending');
		const qr = await call(mounted.route, fakeRequest({ url: testing.LOGIN_QR_PATH }));
		assert.equal(qr.json.qrAvailable, true);
		assert.equal(qr.json.qrRevision >= 1, true);
		assert.equal(qr.body.includes('scan-me'), false);
		const svg = await call(mounted.route, fakeRequest({ url: testing.LOGIN_QR_SVG_PATH }));
		assert.equal(svg.statusCode, 200);
		assert.equal(svg.headers['content-type'], 'image/svg+xml; charset=utf-8');
		assert.equal(svg.headers['cache-control'], 'no-store');
		assert.equal(svg.body.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), true);
		assert.equal((svg.body.match(/<path d="M/g) ?? []).length, 1);
		t.mock.timers.tick(1000);
		for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
		const settled = await call(mounted.route, fakeRequest({ url: testing.STATUS_PATH }));
		assert.equal(settled.json.phase, 'connected');
		assert.equal(settled.json.account, '****7777');
		assert.equal(settled.body.includes('saved-token'), false);
		const { readAccount } = await import('../lib/storage.js');
		const stored = readAccount(join(process.env.DSH_HOME, 'storages', 'channel-weixin'));
		assert.equal(stored.botToken, 'saved-token');
		/* Polling stopped: another tick issues no further status request. */
		const statusCalls = calls.filter((entry) => entry.url.includes('get_qrcode_status')).length;
		t.mock.timers.tick(3000);
		for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
		assert.equal(calls.filter((entry) => entry.url.includes('get_qrcode_status')).length, statusCalls);
	} finally {
		globalThis.fetch = realFetch;
		mounted.dispose();
		t.mock.timers.reset();
	}
});
