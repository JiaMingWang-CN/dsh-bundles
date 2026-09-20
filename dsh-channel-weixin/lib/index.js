/**
 * dsh-channel-weixin — host half.
 *
 * Stage 2 of `docs/weixin-dsh-plugin-plan.md`: the QR-login lifecycle plus the
 * settings-visible connection state. The browser half reads one JSON surface
 * and drives login only through it; the polling secret never leaves this file,
 * and the credential lives in its own private file (see `./storage.js`).
 *
 * Two boundaries this half enforces regardless of later stages:
 * - The published status is an explicit field whitelist, so a new internal
 *   field cannot leak to the page by default.
 * - Mutating routes demand a page-request guard: the harness exposes no
 *   credential check for plugin-owned routes (stage 0 report §5.2), so these
 *   endpoints accept only same-origin browser requests carrying the plugin's
 *   own header, and refuse a foreign Origin outright.
 */

import { LoginSession, POLL_INTERVAL_MS, fetchTypingTicket, pollUpdates, sendText, sendTyping } from './weixin.js';
import { clearAccount, readAccount, readBindings, readSchedules, storageRoot, writeAccount } from './storage.js';
import { encodeQr, toSvg } from './qr.js';
import { ChannelLoop } from './channel.js';
import * as storage from './storage.js';

/** Route prefix owned by this plugin; no shell route is shadowed. */
const ROUTE_PREFIX = '/plugins/channel-weixin';

/** Read-only status surface polled by the settings page. */
const STATUS_PATH = ROUTE_PREFIX + '/status';

/** Login control endpoints (all mutations). */
const LOGIN_START_PATH = ROUTE_PREFIX + '/login/start';
const LOGIN_QR_PATH = ROUTE_PREFIX + '/login/qr';
const LOGIN_QR_SVG_PATH = ROUTE_PREFIX + '/login/qr.svg';
const LOGIN_VERIFY_PATH = ROUTE_PREFIX + '/login/verify';
const LOGIN_CANCEL_PATH = ROUTE_PREFIX + '/login/cancel';
const DISCONNECT_PATH = ROUTE_PREFIX + '/disconnect';
const RECONNECT_PATH = ROUTE_PREFIX + '/reconnect';
const LOGOUT_PATH = ROUTE_PREFIX + '/logout';

/** Stable Cordis plugin name. */
const name = 'channel-weixin';

/** The web carrier is the only dependency: credentials are this plugin's own file. */
const inject = ['webServer'];

/** Largest accepted JSON control body. */
const MAX_BODY_BYTES = 4096;

/** Plugin version, encoded into the protocol's client-version header. */
const PLUGIN_VERSION = '0.1.0';

/**
 * Connection phases the settings page renders.
 */
const PHASES = ['stopped', 'login-pending', 'scanned', 'verify-required', 'connected', 'error'];

/** Bounded length for every string this route echoes back to the page. */
const MAX_TEXT = 300;

/**
 * Initial connection snapshot. Credentials are never part of this object.
 * @returns a fresh snapshot owned by one plugin fiber.
 */
function createStatus() {
	return {
		phase: 'stopped',
		account: '',
		boundSession: '',
		boundCwd: '',
		model: '',
		queueCount: 0,
		scheduleCount: 0,
		lastError: '',
		verifyCodeRequired: false,
		loginExpiresAt: 0,
	};
}

/**
 * Masked account label. The page needs to tell *which* WeChat account is bound,
 * not to read the full identity out of a browser payload.
 * @param account - raw account identity, if any.
 * @returns `''` when unbound, otherwise a masked suffix-only label.
 */
function maskAccount(account) {
	if (typeof account !== 'string' || account === '') return '';
	return account.length <= 4 ? '****' : '****' + account.slice(-4);
}

/** One bounded, JSON-safe string field. */
function text(value) {
	if (typeof value !== 'string') return '';
	return value.length <= MAX_TEXT ? value : value.slice(0, MAX_TEXT);
}

/** One non-negative safe-integer count. */
function count(value) {
	return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/**
 * The public projection of one status snapshot.
 *
 * Deliberately an explicit field whitelist rather than a spread: a later stage
 * that adds a token, cursor, or ticket to the snapshot must also decide, here,
 * whether it is safe to publish — and the default answer is no.
 * @param status - the fiber-owned connection snapshot.
 * @param now - timestamp for the page's freshness line.
 * @returns the JSON body the status route serves.
 */
function publicStatus(status, now = Date.now()) {
	const snapshot = status ?? createStatus();
	return {
		ok: true,
		phase: PHASES.includes(snapshot.phase) ? snapshot.phase : 'error',
		account: maskAccount(snapshot.account),
		boundSession: text(snapshot.boundSession),
		boundCwd: text(snapshot.boundCwd),
		model: text(snapshot.model),
		queueCount: count(snapshot.queueCount),
		scheduleCount: count(snapshot.scheduleCount),
		lastError: text(snapshot.lastError),
		verifyCodeRequired: snapshot.verifyCodeRequired === true,
		loginExpiresAt: Number.isFinite(snapshot.loginExpiresAt) ? snapshot.loginExpiresAt : 0,
		updatedAt: now,
	};
}

/** JSON response; `no-store` keeps live connection state out of every cache. */
function sendJson(response, status, payload) {
	response.statusCode = status;
	response.setHeader('content-type', 'application/json; charset=utf-8');
	response.setHeader('cache-control', 'no-store');
	response.end(JSON.stringify(payload));
}

/** Loopback host names an Origin may carry for a same-machine page request. */
function isLoopbackHost(host) {
	return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/**
 * Whether one request may mutate connection state.
 *
 * The harness leaves plugin-owned routes outside its browser-cookie fence, so
 * this guard is what keeps a stray local caller (or a cross-site form post)
 * from starting a login or logging the user out. It requires the plugin's own
 * header — which a cross-site HTML form cannot set without a CORS preflight —
 * plus a same-origin/none fetch site and, when an Origin is present, a loopback
 * authority.
 * @param request - incoming HTTP request.
 * @returns whether the request may mutate state.
 */
function isTrustedPageRequest(request) {
	const headers = request.headers ?? {};
	if (headers['x-dsh-weixin'] !== '1') return false;
	const site = headers['sec-fetch-site'];
	if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false;
	const origin = headers.origin;
	if (typeof origin === 'string' && origin !== '') {
		try {
			if (!isLoopbackHost(new URL(origin).hostname)) return false;
		} catch {
			return false;
		}
	}
	return true;
}

/**
 * Read a bounded JSON body.
 * @param request - incoming HTTP request.
 * @returns the parsed body, or undefined when absent, oversized, or invalid.
 */
async function readJsonBody(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) return undefined;
		chunks.push(chunk);
	}
	if (size === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		return undefined;
	}
}

/**
 * Host half body: publish connection state and run the QR-login lifecycle.
 *
 * The snapshot, the login session, and the poll timer are created here
 * (fiber-owned) rather than at module scope, so a reloaded or second plugin
 * instance never shares another generation's state. Every registration is a
 * Cordis effect, so disabling the plugin removes the routes and stops polling.
 * @param ctx - host context carrying the web carrier.
 */
function apply(ctx) {
	/** Connection state owned by this plugin fiber. */
	const status = createStatus();
	const root = storageRoot();
	const stored = readAccount(root);
	if (stored !== null) {
		status.phase = 'connected';
		status.account = stored.userId !== '' ? stored.userId : stored.botId;
	}
	/** Active login attempt, if any. */
	let session = null;
	/** Login poll timer while an attempt is active. */
	let timer = null;
	/** Generation of the current login attempt; a newer one invalidates older responses. */
	let loginGeneration = 0;
	/** Generation whose poll is in flight, so one generation never stacks polls. */
	let pollingGeneration = -1;
	/** QR payload for the pending attempt; served only by the QR endpoints. */
	let qrPayload = '';
	/** Bumped whenever the QR payload changes, so the page can bust its image cache. */
	let qrRevision = 0;
	/** The running channel loop, when credentials exist and the owner enabled it. */
	let loop = null;

	/**
	 * Every protocol call for this account, bound to the ambient fetch and the
	 * account's route. Building it here keeps `lib/channel.js` free of transport
	 * details and testable without a socket.
	 */
	const buildTransport = (account) => ({
		pollUpdates: (options) => pollUpdates({ fetchImpl: (url, init) => fetch(url, init), baseUrl: account.baseUrl, ...options }),
		sendText: (options) => sendText({ fetchImpl: (url, init) => fetch(url, init), baseUrl: account.baseUrl, ...options }),
		fetchTypingTicket: (options) => fetchTypingTicket({ fetchImpl: (url, init) => fetch(url, init), baseUrl: account.baseUrl, ...options }),
		sendTyping: (options) => sendTyping({ fetchImpl: (url, init) => fetch(url, init), baseUrl: account.baseUrl, ...options }),
	});

	/** React to one loop report without letting it break the loop. */
	const onLoopStatus = (event) => {
		if (event.kind === 'stale-credential') {
			status.phase = 'error';
			status.lastError = '微信登录凭证已失效，请重新扫码连接。';
			return;
		}
		if (event.kind === 'poll-failed') {
			status.lastError = `消息接收失败（已重试 ${event.failures} 次）：${event.error}`;
			return;
		}
		if (event.kind === 'submitted') {
			status.queueCount += 1;
			status.lastError = '';
			return;
		}
		if (event.kind === 'settled' || event.kind === 'timeout') {
			status.queueCount = Math.max(0, status.queueCount - 1);
			if (event.bodyError !== undefined && event.bodyError !== '') status.lastError = `回复发送失败：${event.bodyError}`;
			return;
		}
		if (event.kind === 'error') {
			status.lastError = `任务失败：${event.error}`;
		}
	};

	/** Stop the channel loop; idempotent, and never leaves a dead loop referenced. */
	const stopLoop = () => {
		if (loop === null) return;
		loop.stop('stopped');
		loop = null;
		status.queueCount = 0;
	};

	/**
	 * Start receiving messages, when both prerequisites exist: a stored credential
	 * and the harness services the loop drives. Without either, the plugin still
	 * serves its settings page.
	 */
	const startLoop = () => {
		const account = readAccount(root);
		const agents = ctx.get('agents');
		if (account === null || agents === undefined) return false;
		stopLoop();
		loop = new ChannelLoop({
			account,
			root,
			agents,
			permissionPresets: ctx.get('permissionPresets'),
			persistence: ctx.get('sessionPersistence'),
			storage,
			transport: buildTransport(account),
			version: PLUGIN_VERSION,
			onStatus: onLoopStatus,
			/* Read through getters rather than capturing values: a service mounted after
			 * this loop started (a model route, the query backend) must be visible to
			 * the next command instead of staying invisible until a restart. The getters
			 * are evaluated per command, so no consumer keeps a stale reference. */
			services: {
				get agentPresets() { return ctx.get('agentPresets'); },
				get llm() { return ctx.get('llm'); },
				get agentDefaultModel() { return ctx.get('agentDefaultModel'); },
				get sessionProjections() { return ctx.get('sessionProjections'); },
				get sessionQuery() { return ctx.get('sessionQuery'); },
			},
		});
		loop.run().catch(() => {});
		return true;
	};

	/**
	 * The model a session is actually set to, read from the live projection.
	 *
	 * The selection lives in the session (a `model/selection` event), not in this
	 * plugin's binding, and it can also be changed from the browser. Reading the
	 * projection means the page reflects reality instead of the last value this
	 * plugin happened to write.
	 * @param sessionId - the bound session.
	 * @returns `provider/model`, or `''` when nothing can be read.
	 */
	const liveModel = (sessionId) => {
		const agents = ctx.get('agents');
		const projections = ctx.get('sessionProjections');
		if (agents === undefined || projections === undefined) return '';
		const agent = typeof agents.get === 'function' ? agents.get(sessionId) : undefined;
		if (agent?.session === undefined || typeof projections.stateOf !== 'function') return '';
		try {
			const state = projections.stateOf(agent.session, 'modelSelection');
			const selection = state?.pending ?? state?.lastUsed;
			if (selection === undefined || selection === null) return '';
			return typeof selection.provider === 'string' && typeof selection.model === 'string' ? `${selection.provider}/${selection.model}` : '';
		} catch {
			return '';
		}
	};

	/**
	 * The page's binding and schedule counters, read from storage.
	 *
	 * The status route is the only place these are published, so they are
	 * refreshed on read rather than mirrored in memory: a binding changed over
	 * WeChat must show up on the next poll without another writer to keep in sync.
	 */
	const refreshPublished = () => {
		status.scheduleCount = readSchedules(root).entries.length;
		const stored = readAccount(root);
		if (stored === null) return;
		const peer = stored.userId !== '' ? stored.userId : stored.botId;
		const binding = readBindings(root)[peer];
		if (binding === undefined) {
			status.boundSession = '';
			status.boundCwd = '';
			status.model = '';
			return;
		}
		status.boundSession = binding.sessionId;
		status.boundCwd = binding.cwd;
		status.model = liveModel(binding.sessionId) || binding.model;
	};

	/** Stop polling; idempotent. */
	const stopPolling = () => {
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
	};

	/** Adopt one login snapshot into the fiber-owned status. */
	const adopt = (snapshot) => {
		if (snapshot.qrPayload !== qrPayload) {
			qrPayload = snapshot.qrPayload;
			qrRevision += 1;
		}
		status.lastError = snapshot.error;
		status.verifyCodeRequired = snapshot.verifyCodeRequired;
		status.loginExpiresAt = snapshot.expiresAt;
		if (snapshot.phase === 'idle') {
			status.phase = readAccount(root) === null ? 'stopped' : 'connected';
			return;
		}
		status.phase = PHASES.includes(snapshot.phase) ? snapshot.phase : 'error';
	};

	/** Persist successful credentials and settle the connection state. */
	const persist = (account) => {
		writeAccount(root, account);
		status.account = account.userId !== '' ? account.userId : account.botId;
		status.lastError = '';
		status.verifyCodeRequired = false;
		status.loginExpiresAt = 0;
		status.phase = 'connected';
		/* Receiving starts as soon as a credential exists. */
		startLoop();
	};

	/** Drop the pending QR payload; the revision bump invalidates the page's image. */
	const dropQr = () => {
		if (qrPayload !== '') {
			qrPayload = '';
			qrRevision += 1;
		}
	};

	/** Whether a scannable code currently exists. */
	const qrPending = () => status.phase === 'login-pending' || status.phase === 'scanned' || status.phase === 'verify-required';

	/**
	 * Poll the pending login once, persisting credentials when it confirms.
	 *
	 * A poll belongs to one login generation: replacing the attempt (or
	 * cancelling it) bumps the generation, and a response that arrives afterwards
	 * is discarded. Without that, a slow `confirmed` from a superseded QR could
	 * still write a credential and flip the page to "connected" — exactly the
	 * stale-response overwrite the plan forbids.
	 */
	const pollOnce = async () => {
		if (session === null) return;
		/* One poll per generation: a superseded generation's poll no longer blocks. */
		if (pollingGeneration === loginGeneration) return;
		const generation = loginGeneration;
		const attempt = session;
		pollingGeneration = generation;
		try {
			const snapshot = await attempt.pollOnce();
			if (generation !== loginGeneration) return;
			if (snapshot.phase === 'connected' && snapshot.account !== null) {
				persist(snapshot.account);
				session = null;
				dropQr();
				stopPolling();
				return;
			}
			adopt(snapshot);
			if (!attempt.active) {
				session = null;
				stopPolling();
			}
		} finally {
			if (pollingGeneration === generation) pollingGeneration = -1;
		}
	};

	/** Start (or restart) a login attempt and its poll timer. */
	const startLogin = async () => {
		stopPolling();
		/* A new attempt supersedes the previous one and its in-flight responses. */
		const generation = loginGeneration + 1;
		loginGeneration = generation;
		const attempt = new LoginSession({ fetchImpl: (url, options) => fetch(url, options), version: PLUGIN_VERSION });
		session = attempt;
		const snapshot = await attempt.start();
		if (generation !== loginGeneration) return;
		adopt(snapshot);
		if (snapshot.phase === 'connected' && snapshot.account !== null) {
			persist(snapshot.account);
			session = null;
			return;
		}
		if (!attempt.active) {
			session = null;
			return;
		}
		timer = setInterval(() => { pollOnce().catch(() => {}); }, POLL_INTERVAL_MS);
	};

	/** One route dispatch over the plugin's prefix. */
	const dispatch = async (request, response, pathname) => {
		if (pathname === STATUS_PATH) {
			if (request.method !== 'GET' && request.method !== 'HEAD') {
				sendJson(response, 405, { ok: false, reason: 'method-not-allowed' });
				return;
			}
			refreshPublished();
			sendJson(response, 200, publicStatus(status));
			return;
		}
		if (pathname === LOGIN_QR_PATH) {
			if (request.method !== 'GET' && request.method !== 'HEAD') {
				sendJson(response, 405, { ok: false, reason: 'method-not-allowed' });
				return;
			}
			sendJson(response, 200, {
				ok: true,
				phase: status.phase,
				qrAvailable: qrPending() && qrPayload !== '',
				qrRevision,
				expiresAt: publicStatus(status).loginExpiresAt,
			});
			return;
		}
		if (pathname === LOGIN_QR_SVG_PATH) {
			if (request.method !== 'GET' && request.method !== 'HEAD') {
				sendJson(response, 405, { ok: false, reason: 'method-not-allowed' });
				return;
			}
			if (!qrPending() || qrPayload === '') {
				sendJson(response, 404, { ok: false, reason: 'no-pending-qr' });
				return;
			}
			/* The payload is server-provided, so its length is not assumed: try the
			 * normal correction level, then the most permissive one, and report a
			 * reason the page can show instead of leaving a broken image. */
			for (const ecc of ['M', 'L']) {
				try {
					const svg = toSvg(encodeQr(qrPayload, { ecc }), { scale: 6, margin: 4 });
					response.statusCode = 200;
					response.setHeader('content-type', 'image/svg+xml; charset=utf-8');
					response.setHeader('cache-control', 'no-store');
					response.end(svg);
					return;
				} catch {
					/* Fall through to the next level; the last failure is reported below. */
				}
			}
			sendJson(response, 422, { ok: false, reason: 'qr-too-long' });
			return;
		}
		if (request.method !== 'POST') {
			sendJson(response, 405, { ok: false, reason: 'method-not-allowed' });
			return;
		}
		if (!isTrustedPageRequest(request)) {
			sendJson(response, 403, { ok: false, reason: 'untrusted-request' });
			return;
		}
		if (pathname === LOGIN_START_PATH) {
			await startLogin();
			sendJson(response, 200, { ok: true, status: publicStatus(status) });
			return;
		}
		if (pathname === LOGIN_VERIFY_PATH) {
			const body = await readJsonBody(request);
			const accepted = session !== null && session.submitVerifyCode(body?.code);
			sendJson(response, accepted ? 200 : 400, {
				ok: accepted,
				reason: accepted ? void 0 : 'invalid-or-inactive-code',
				status: publicStatus(status),
			});
			return;
		}
		if (pathname === LOGIN_CANCEL_PATH) {
			/* Supersede the attempt so an in-flight response cannot revive it. */
			loginGeneration += 1;
			if (session !== null) adopt(session.cancel());
			session = null;
			dropQr();
			stopPolling();
			sendJson(response, 200, { ok: true, status: publicStatus(status) });
			return;
		}
		if (pathname === DISCONNECT_PATH) {
			/* Stop receiving but keep the credential: reconnecting must not need a new scan. */
			stopLoop();
			if (status.phase !== 'error') status.phase = 'stopped';
			sendJson(response, 200, { ok: true, status: publicStatus(status) });
			return;
		}
		if (pathname === RECONNECT_PATH) {
			/* Resume receiving with the stored credential, without a new scan. */
			const account = readAccount(root);
			if (account === null) {
				sendJson(response, 400, { ok: false, reason: 'no-credential' });
				return;
			}
			if (ctx.get('agents') === undefined) {
				sendJson(response, 400, { ok: false, reason: 'agents-unavailable' });
				return;
			}
			if (startLoop() !== true) {
				sendJson(response, 400, { ok: false, reason: 'reconnect-failed' });
				return;
			}
			status.phase = 'connected';
			status.account = account.userId !== '' ? account.userId : account.botId;
			status.lastError = '';
			sendJson(response, 200, { ok: true, status: publicStatus(status) });
			return;
		}
		if (pathname === LOGOUT_PATH) {
			/* Supersede the attempt: a late confirmation must not write a credential. */
			loginGeneration += 1;
			if (session !== null) adopt(session.cancel());
			session = null;
			dropQr();
			stopPolling();
			/* This account's plans leave with it: they must not fire for a later account.
			 * Done straight from storage, because a disconnected plugin has no loop. */
			const leaving = status.account;
			if (loop !== null) loop.dropSchedulesFor(leaving);
			else storage.removeSchedulesForPeer(root, leaving);
			stopLoop();
			clearAccount(root);
			status.account = '';
			status.phase = 'stopped';
			status.lastError = '';
			status.verifyCodeRequired = false;
			status.loginExpiresAt = 0;
			sendJson(response, 200, { ok: true, status: publicStatus(status) });
			return;
		}
		sendJson(response, 404, { ok: false, reason: 'not-found' });
	};

	ctx.effect(() => ctx.webServer.register({
		kind: 'prefix',
		path: ROUTE_PREFIX,
		handler: (request, response) => {
			const url = new URL(request.url ?? '/', 'http://localhost');
			dispatch(request, response, url.pathname).catch(() => {
				sendJson(response, 500, { ok: false, reason: 'internal-error' });
			});
		},
	}), 'channel-weixin: ' + ROUTE_PREFIX);
	ctx.effect(() => stopPolling, 'channel-weixin: login poll timer');
	ctx.effect(() => stopLoop, 'channel-weixin: channel loop');
	/* Attribution inputs: live frames, durable events, inbox claims, agent errors. */
	ctx.effect(() => ctx.on('agent/assistant-stream', ({ agent, frame }) => {
		if (loop !== null) loop.onAgentFrame(agent, frame);
	}), 'channel-weixin: assistant stream attribution');
	ctx.effect(() => ctx.on('session/event', (session, event) => {
		if (loop !== null) loop.onSessionEvent(session, event);
	}), 'channel-weixin: session event attribution');
	ctx.effect(() => ctx.on('agent/inbox/claimed', ({ message, turn }) => {
		if (loop !== null) loop.onInboxClaimed(message, turn);
	}), 'channel-weixin: inbox claim attribution');
	ctx.effect(() => ctx.on('agent/error', ({ agent, error }) => {
		if (loop !== null) loop.onAgentError(agent, error);
	}), 'channel-weixin: agent error attribution');
	/* Credentials restored from a previous run resume receiving immediately. */
	if (stored !== null) startLoop();
}

/** Pure helpers exercised by the unit tests. */
const testing = {
	createStatus, maskAccount, publicStatus, sendJson, isTrustedPageRequest, readJsonBody,
	PHASES, STATUS_PATH, ROUTE_PREFIX, LOGIN_START_PATH, LOGIN_QR_PATH, LOGIN_QR_SVG_PATH,
	LOGIN_VERIFY_PATH, LOGIN_CANCEL_PATH, DISCONNECT_PATH, RECONNECT_PATH, LOGOUT_PATH,
	PLUGIN_VERSION,
};

export { apply, inject, name, testing };
