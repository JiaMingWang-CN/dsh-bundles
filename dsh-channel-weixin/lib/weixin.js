/**
 * WeChat ilink bot protocol client and QR-login state machine.
 *
 * Independent implementation: no OpenClaw package, SDK, gateway, or state
 * directory is involved. Endpoint shapes follow the protocol facts established
 * in `docs/stage0-weixin-protocol.md`; the reference project itself states that
 * client behaviour is not a complete server contract, so every server answer is
 * treated as untrusted input here.
 *
 * Two fields are deliberately kept apart:
 * - `qrcode` is the polling secret. It never leaves this module.
 * - `qrPayload` is the scannable link the settings page must display.
 *
 * Everything network-facing is injected (`fetchImpl`, `now`), so the whole
 * state machine is unit-testable without a socket.
 */

/** Fixed login base URL: QR requests always start here (the reference's FIXED_BASE_URL). */
const FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com';

/** `bot_type` for this channel build. */
const BOT_TYPE = '3';

/** Application identity header value; a protocol constant, not a brand derived from another client. */
const APP_ID = 'bot';

/** Client-side timeout for one long-poll status request. */
const QR_LONG_POLL_TIMEOUT_MS = 35_000;

/** A login instance older than this is expired locally, whatever the server says. */
const LOGIN_TTL_MS = 5 * 60_000;

/** How many QR refreshes one login attempt may consume before giving up. */
const MAX_QR_REFRESH = 3;

/** Delay between two status polls of one pending login. */
const POLL_INTERVAL_MS = 1000;

/** Client-side timeout for one long-poll `getupdates` request. */
const UPDATES_TIMEOUT_MS = 35_000;

/** Observation identity sent in `base_info`; this plugin's own, never another client's. */
const BOT_AGENT = 'dsh-channel-weixin';

/** Error code meaning the stored credential is stale and must be re-scanned. */
const STALE_TOKEN_ERRCODE = -14;

/** Response fields carrying uint64 identifiers that must not lose precision. */
const ID_FIELDS = ['message_id', 'msg_id', 'svr_id', 'seq'];

/** Item type carrying plain text. */
const ITEM_TYPE_TEXT = 1;

/** `message_type` value used by the bot's own outbound messages. */
const MESSAGE_TYPE_BOT = 2;

/** Login phases this module publishes (a superset of the host's connection phases). */
const LOGIN_PHASES = [
	'idle',
	'login-pending',
	'scanned',
	'verify-required',
	'connected',
	'expired',
	'error',
];

/** Server status values mapped onto {@link LOGIN_PHASES}. */
const STATUS_PHASES = {
	wait: 'login-pending',
	scaned: 'scanned',
	need_verifycode: 'verify-required',
	confirmed: 'connected',
	expired: 'expired',
	scaned_but_redirect: 'scanned',
	verify_code_blocked: 'error',
	binded_redirect: 'error',
};

/** Hosts a redirect may point at: the WeChat domain and its subdomains, nothing else. */
const REDIRECT_HOST = /^(?:[a-z0-9-]+\.)*weixin\.qq\.com$/i;

/** Fields the caller may read from one server status answer. */
const STATUS_FIELDS = ['bot_token', 'ilink_bot_id', 'baseurl', 'ilink_user_id', 'redirect_host'];

/** Version header encoding: 0x00MMNNPP as a decimal string. */
function clientVersion(version) {
	const parts = String(version ?? '0.0.0')
		.split('.')
		.map((part) => Number.parseInt(part, 10))
		.map((part) => (Number.isFinite(part) && part > 0 ? part : 0));
	const major = parts[0] ?? 0;
	const minor = parts[1] ?? 0;
	const patch = parts[2] ?? 0;
	return String(((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff));
}

/**
 * Headers every application request carries. Deliberately no HTTP `User-Agent`
 * (the protocol does not use one) and no authorization.
 * @param version - plugin version encoded into `iLink-App-ClientVersion`.
 * @returns header record for application-level requests.
 */
function appHeaders(version) {
	return {
		'iLink-App-Id': APP_ID,
		'iLink-App-ClientVersion': clientVersion(version),
	};
}

/** One random `X-WECHAT-UIN`: a uint32's decimal text, base64-encoded. */
function randomWechatUin(random = Math.random) {
	const value = Math.floor(random() * 0xffffffff) >>> 0;
	return Buffer.from(String(value), 'utf8').toString('base64');
}

/**
 * Headers for authenticated bot requests.
 * @param token - bot token obtained at login.
 * @param version - plugin version.
 * @param random - injectable randomness for the UIN header.
 * @returns header record including the Bearer credential.
 */
function botHeaders(token, version, random = Math.random) {
	return {
		...appHeaders(version),
		'content-type': 'application/json',
		AuthorizationType: 'ilink_bot_token',
		Authorization: 'Bearer ' + token,
		'X-WECHAT-UIN': randomWechatUin(random),
	};
}

/**
 * Accept a redirect host only when it is a bare label sequence inside the
 * WeChat domain. Anything else (scheme, path, port, foreign domain) is refused
 * rather than followed: the polling request carries the QR secret.
 * @param redirectHost - the server-provided host.
 * @returns the absolute HTTPS base URL, or undefined when untrusted.
 */
function redirectBase(redirectHost) {
	if (typeof redirectHost !== 'string' || redirectHost === '') return undefined;
	if (redirectHost.includes('/') || redirectHost.includes(':') || redirectHost.includes(' ')) return undefined;
	if (!REDIRECT_HOST.test(redirectHost)) return undefined;
	return 'https://' + redirectHost.toLowerCase();
}

/** Validate an authenticated API base before any bearer credential is sent. */
function trustedBaseUrl(value) {
	if (typeof value !== 'string' || value === '') return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return undefined;
		if (!REDIRECT_HOST.test(url.hostname)) return undefined;
		if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined;
		return url.origin;
	} catch {
		return undefined;
	}
}

/** Pick the whitelisted fields of one status answer. */
function statusFields(body) {
	const picked = {};
	if (body === null || typeof body !== 'object') return picked;
	for (const field of STATUS_FIELDS) {
		const value = body[field];
		if (typeof value === 'string' && value !== '') picked[field] = value;
	}
	return picked;
}

/** One JSON request with a bounded client timeout; the caller owns abort semantics. */
async function requestJson(fetchImpl, url, options, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(url, { ...options, signal: controller.signal });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return await readJsonLossless(response);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Quote uint64 identifier literals before `JSON.parse` sees them.
 *
 * `message_id` and friends are uint64 on the wire, and a JSON number beyond
 * 2^53 silently loses precision — which would make two distinct messages
 * compare equal in the dedupe table. Only literals of 16+ digits under an
 * identifier key are quoted, so ordinary numbers keep their type.
 * @param raw - the raw response body.
 * @returns the body with oversized identifier literals quoted.
 */
function quoteLargeIntegers(raw) {
	const pattern = new RegExp(`"(${ID_FIELDS.join('|')})"\\s*:\\s*(-?\\d{16,})`, 'g');
	return raw.replace(pattern, '"$1":"$2"');
}

/**
 * Parse one JSON body without losing uint64 identifiers.
 * @param response - a fetch response.
 * @returns the parsed body.
 */
async function readJsonLossless(response) {
	const raw = await response.text();
	const quoted = quoteLargeIntegers(raw);
	try {
		return JSON.parse(quoted);
	} catch {
		return JSON.parse(raw);
	}
}

/** The `base_info` every bot request carries; this plugin's own observation identity. */
function baseInfo(version) {
	return { channel_version: String(version ?? ''), bot_agent: BOT_AGENT };
}

/**
 * One client-generated message id. The prefix names this plugin, so an inbound
 * echo of our own send is attributable without guessing.
 * @param now - clock.
 * @param random - injectable randomness.
 * @returns `dsh-channel-weixin:<timestamp>-<8 hex>`.
 */
function clientId(now = Date.now, random = Math.random) {
	const suffix = Math.floor(random() * 0x100000000).toString(16).padStart(8, '0');
	return `${BOT_AGENT}:${now()}-${suffix}`;
}

/**
 * Long-poll the inbound message queue.
 *
 * A client timeout is not an error: it means "no messages yet", so the caller
 * simply polls again with the same cursor (the reference behaves the same way).
 * A stale-credential answer is surfaced as `stale` so the caller can stop and
 * ask for a new scan instead of retrying a dead token at full speed.
 * @param options - fetch implementation, route, credential, cursor, and timeout.
 * @returns `{ messages, cursor, stale, timedOut }`.
 */
async function pollUpdates({ fetchImpl, baseUrl = FIXED_BASE_URL, token, version, cursor = '', timeoutMs = UPDATES_TIMEOUT_MS, random = Math.random }) {
	const body = { get_updates_buf: typeof cursor === 'string' ? cursor : '', base_info: baseInfo(version) };
	let answer;
	try {
		answer = await requestJson(fetchImpl, `${baseUrl}/ilink/bot/getupdates`, {
			method: 'POST',
			headers: botHeaders(token, version, random),
			body: JSON.stringify(body),
		}, timeoutMs);
	} catch (error) {
		const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError';
		if (aborted) return { messages: [], cursor: body.get_updates_buf, stale: false, timedOut: true };
		throw error;
	}
	const code = Number(answer?.errcode ?? answer?.ret ?? 0);
	if (code === STALE_TOKEN_ERRCODE) return { messages: [], cursor: body.get_updates_buf, stale: true, timedOut: false };
	if (code !== 0) throw new Error(`getupdates failed: ret=${String(answer?.ret)} errcode=${String(answer?.errcode)} ${String(answer?.errmsg ?? '')}`.trim());
	const messages = Array.isArray(answer?.msgs) ? answer.msgs.filter((message) => message !== null && typeof message === 'object') : [];
	const next = typeof answer?.get_updates_buf === 'string' && answer.get_updates_buf !== '' ? answer.get_updates_buf : body.get_updates_buf;
	const suggested = Number(answer?.longpolling_timeout_ms);
	return {
		messages,
		cursor: next,
		stale: false,
		timedOut: false,
		suggestedTimeoutMs: Number.isFinite(suggested) && suggested > 0 ? Math.min(suggested, 120_000) : undefined,
	};
}

/**
 * Send one text message.
 * @param options - fetch implementation, route, credential, recipient, text, and context token.
 * @returns `{ ok, messageId }` with the server id as a lossless string.
 */
async function sendText({ fetchImpl, baseUrl = FIXED_BASE_URL, token, version, toUserId, text, contextToken, runId, now = Date.now, random = Math.random }) {
	const message = {
		from_user_id: '',
		to_user_id: String(toUserId ?? ''),
		client_id: clientId(now, random),
		message_type: MESSAGE_TYPE_BOT,
		message_state: 2,
		...(typeof contextToken === 'string' && contextToken !== '' ? { context_token: contextToken } : {}),
		...(typeof runId === 'string' && runId !== '' ? { run_id: runId } : {}),
		item_list: [{ type: ITEM_TYPE_TEXT, text_item: { text: String(text ?? '') } }],
	};
	const answer = await requestJson(fetchImpl, `${baseUrl}/ilink/bot/sendmessage`, {
		method: 'POST',
		headers: botHeaders(token, version, random),
		body: JSON.stringify({ msg: message, base_info: baseInfo(version) }),
	}, 20_000);
	const code = Number(answer?.ret ?? 0);
	if (code !== 0) throw new Error(`sendmessage failed: ret=${String(answer?.ret)} ${String(answer?.errmsg ?? '')}`.trim());
	return { ok: true, messageId: typeof answer?.message_id === 'string' ? answer.message_id : '' };
}

/**
 * Fetch the typing ticket for one peer.
 * @param options - fetch implementation, route, credential, and peer identity.
 * @returns the ticket, or `''` when the server sent none.
 */
async function fetchTypingTicket({ fetchImpl, baseUrl = FIXED_BASE_URL, token, version, peerUserId, contextToken, random = Math.random }) {
	const answer = await requestJson(fetchImpl, `${baseUrl}/ilink/bot/getconfig`, {
		method: 'POST',
		headers: botHeaders(token, version, random),
		body: JSON.stringify({
			ilink_user_id: String(peerUserId ?? ''),
			...(typeof contextToken === 'string' && contextToken !== '' ? { context_token: contextToken } : {}),
			base_info: baseInfo(version),
		}),
	}, 15_000);
	if (Number(answer?.ret ?? 0) !== 0) return '';
	return typeof answer?.typing_ticket === 'string' ? answer.typing_ticket : '';
}

/**
 * Show or clear the peer's typing indicator. The answer's business code is not
 * inspected (the reference treats this as best-effort): a failed indicator must
 * never disturb the reply itself.
 * @param options - fetch implementation, route, credential, peer, ticket, and status.
 * @returns whether the request was accepted by the transport.
 */
async function sendTyping({ fetchImpl, baseUrl = FIXED_BASE_URL, token, version, peerUserId, typingTicket, status, random = Math.random }) {
	if (typeof typingTicket !== 'string' || typingTicket === '') return false;
	try {
		await requestJson(fetchImpl, `${baseUrl}/ilink/bot/sendtyping`, {
			method: 'POST',
			headers: botHeaders(token, version, random),
			body: JSON.stringify({
				ilink_user_id: String(peerUserId ?? ''),
				typing_ticket: typingTicket,
				status: status === 2 ? 2 : 1,
				base_info: baseInfo(version),
			}),
		}, 10_000);
		return true;
	} catch {
		return false;
	}
}

/**
 * Fetch one login QR code.
 * @param options - fetch implementation, base URL, plugin version, timeout.
 * @returns the polling secret plus the payload the page must display.
 */
async function requestQrCode({ fetchImpl, baseUrl = FIXED_BASE_URL, version, timeoutMs = 20_000 }) {
	const url = `${baseUrl}/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`;
	const body = await requestJson(fetchImpl, url, {
		method: 'POST',
		headers: { ...appHeaders(version), 'content-type': 'application/json' },
		body: JSON.stringify({ local_token_list: [] }),
	}, timeoutMs);
	if (typeof body?.qrcode !== 'string' || typeof body?.qrcode_img_content !== 'string') {
		throw new Error('qrcode response is missing qrcode or qrcode_img_content');
	}
	return { qrcode: body.qrcode, qrPayload: body.qrcode_img_content };
}

/**
 * Poll one QR login status.
 * @param options - fetch implementation, base URL, polling secret, optional verification code.
 * @returns the status value plus its whitelisted fields.
 */
async function pollQrStatus({ fetchImpl, baseUrl = FIXED_BASE_URL, version, qrcode, verifyCode, timeoutMs = QR_LONG_POLL_TIMEOUT_MS }) {
	const query = new URLSearchParams({ qrcode });
	if (typeof verifyCode === 'string' && verifyCode !== '') query.set('verify_code', verifyCode);
	const url = `${baseUrl}/ilink/bot/get_qrcode_status?${query.toString()}`;
	const body = await requestJson(fetchImpl, url, { method: 'GET', headers: appHeaders(version) }, timeoutMs);
	const status = typeof body?.status === 'string' ? body.status : '';
	if (!Object.hasOwn(STATUS_PHASES, status)) throw new Error(`unknown login status ${JSON.stringify(status)}`);
	return { status, fields: statusFields(body) };
}

/**
 * One QR-login attempt.
 *
 * The instance owns the polling secret, the current phase, the verification
 * code the user typed, and the bounded refresh budget. It never logs or returns
 * the secret; `snapshot()` is what the settings page may see.
 */
class LoginSession {
	/**
	 * @param options - fetch implementation, plugin version, clock, base URL.
	 */
	constructor({ fetchImpl, version, now = Date.now, baseUrl = FIXED_BASE_URL, random = Math.random } = {}) {
		this.fetchImpl = fetchImpl;
		this.version = version;
		this.now = now;
		this.random = random;
		this.baseUrl = baseUrl;
		this.qrcode = '';
		this.qrPayload = '';
		this.phase = 'idle';
		this.error = '';
		this.refreshes = 0;
		this.startedAt = 0;
		this.pendingVerifyCode = '';
		this.account = null;
	}

	/** Whether the attempt is still actionable (pending, unexpired). */
	get active() {
		return this.phase === 'login-pending' || this.phase === 'scanned' || this.phase === 'verify-required';
	}

	/** What the settings page may see: no polling secret, no verification code. */
	snapshot() {
		return {
			phase: this.phase,
			qrPayload: this.active ? this.qrPayload : '',
			error: this.error,
			expiresAt: this.active ? this.startedAt + LOGIN_TTL_MS : 0,
			verifyCodeRequired: this.phase === 'verify-required',
			account: this.account,
		};
	}

	/** Record one failure without leaking transport detail into the phase machine. */
	fail(message) {
		this.phase = 'error';
		this.error = message;
		this.qrcode = '';
		this.qrPayload = '';
		this.pendingVerifyCode = '';
		return this.snapshot();
	}

	/**
	 * Start the attempt: fetch the first QR code.
	 * @returns the page-visible snapshot.
	 */
	async start() {
		this.refreshes = 0;
		this.error = '';
		this.pendingVerifyCode = '';
		this.account = null;
		this.startedAt = this.now();
		try {
			const { qrcode, qrPayload } = await requestQrCode({ fetchImpl: this.fetchImpl, baseUrl: FIXED_BASE_URL, version: this.version });
			this.qrcode = qrcode;
			this.qrPayload = qrPayload;
			this.phase = 'login-pending';
		} catch (error) {
			return this.fail('二维码获取失败：' + String(error?.message ?? error));
		}
		return this.snapshot();
	}

	/** Replace an expired or blocked QR code, bounded by {@link MAX_QR_REFRESH}. */
	async refresh() {
		if (this.refreshes >= MAX_QR_REFRESH) return this.fail('二维码多次失效，请重新发起连接');
		this.refreshes += 1;
		this.startedAt = this.now();
		try {
			const { qrcode, qrPayload } = await requestQrCode({ fetchImpl: this.fetchImpl, baseUrl: FIXED_BASE_URL, version: this.version });
			this.qrcode = qrcode;
			this.qrPayload = qrPayload;
			this.phase = 'login-pending';
			this.error = '';
		} catch (error) {
			return this.fail('二维码刷新失败：' + String(error?.message ?? error));
		}
		return this.snapshot();
	}

	/**
	 * Arm one verification code for the next poll. The code is held in memory
	 * only, never persisted and never returned.
	 * @param code - digits the user read from their phone.
	 * @returns whether the code was accepted as a pending value.
	 */
	submitVerifyCode(code) {
		if (!this.active) return false;
		const trimmed = String(code ?? '').trim();
		if (!/^\d{4,8}$/.test(trimmed)) return false;
		this.pendingVerifyCode = trimmed;
		return true;
	}

	/** Stop the attempt locally; the server side expires on its own. */
	cancel() {
		this.phase = 'idle';
		this.qrcode = '';
		this.qrPayload = '';
		this.pendingVerifyCode = '';
		this.error = '';
		this.account = null;
		return this.snapshot();
	}

	/**
	 * Poll once and advance the phase.
	 *
	 * Network failures and client timeouts leave the attempt pending (the
	 * reference's behaviour): only explicit server answers change the phase, so a
	 * flaky socket cannot silently end a login the user is still completing.
	 * @returns the page-visible snapshot.
	 */
	async pollOnce() {
		if (!this.active) return this.snapshot();
		if (this.now() - this.startedAt > LOGIN_TTL_MS) {
			this.phase = 'expired';
			return this.refresh();
		}
		/* The code rides the poll only after the server asked for one: a code typed
		 * early is held locally rather than spent on a request that did not need it. */
		const verified = this.phase === 'verify-required' ? this.pendingVerifyCode : '';
		let answer;
		try {
			answer = await pollQrStatus({
				fetchImpl: this.fetchImpl,
				baseUrl: this.baseUrl,
				version: this.version,
				qrcode: this.qrcode,
				verifyCode: verified,
			});
		} catch (error) {
			this.error = '状态查询失败：' + String(error?.message ?? error);
			return this.snapshot();
		}
		const phase = STATUS_PHASES[answer.status];
		const { fields } = answer;
		switch (answer.status) {
			case 'confirmed': {
				if (typeof fields.bot_token !== 'string' || fields.bot_token === '') {
					return this.fail('服务端未返回登录凭证');
				}
				if (typeof fields.ilink_user_id !== 'string' || fields.ilink_user_id === '') {
					return this.fail('服务端未返回扫码用户身份，无法安全限制发送者');
				}
				const baseUrl = fields.baseurl === undefined ? FIXED_BASE_URL : trustedBaseUrl(fields.baseurl);
				if (baseUrl === undefined) return this.fail('服务端返回了不可信的 API 地址，已拒绝保存凭证');
				this.account = {
					botToken: fields.bot_token,
					botId: fields.ilink_bot_id ?? '',
					userId: fields.ilink_user_id,
					baseUrl,
				};
				this.phase = 'connected';
				this.qrcode = '';
				this.qrPayload = '';
				this.pendingVerifyCode = '';
				return this.snapshot();
			}
			case 'verify_code_blocked': {
				this.pendingVerifyCode = '';
				this.refreshes += 1;
				return this.fail('验证码错误次数过多，请重新发起连接');
			}
			case 'expired': {
				this.phase = 'expired';
				return this.refresh();
			}
			case 'scaned_but_redirect': {
				const base = redirectBase(fields.redirect_host);
				if (base === undefined) {
					return this.fail('服务端返回了不可信的重定向地址，已停止本次登录');
				}
				this.baseUrl = base;
				this.phase = 'scanned';
				this.error = '';
				return this.snapshot();
			}
			case 'binded_redirect': {
				return this.fail('该微信账号已绑定其他接入端，未建立本机连接');
			}
			case 'need_verifycode': {
				/* A code we already sent and the server asks again means it was wrong:
				 * retire it and say so, rather than resending it on every poll (which
				 * would burn the server's attempt budget). */
				if (verified !== '') {
					this.pendingVerifyCode = '';
					this.error = '验证码不正确，请重新输入。';
				} else {
					this.error = '';
				}
				this.phase = 'verify-required';
				return this.snapshot();
			}
			default: {
				/* wait / scaned: the verification code, once accepted, is retired. */
				if (verified !== '' && this.pendingVerifyCode === verified) this.pendingVerifyCode = '';
				this.phase = phase;
				this.error = '';
				return this.snapshot();
			}
		}
	}

	/** Number of QR refreshes consumed so far; exposed for diagnostics only. */
	get refreshCount() {
		return this.refreshes;
	}
}

/** Pure helpers exercised by the unit tests. */
const testing = {
	FIXED_BASE_URL, BOT_TYPE, APP_ID, BOT_AGENT, LOGIN_PHASES, STATUS_PHASES, MAX_QR_REFRESH,
	LOGIN_TTL_MS, POLL_INTERVAL_MS, QR_LONG_POLL_TIMEOUT_MS, UPDATES_TIMEOUT_MS, ID_FIELDS,
	STALE_TOKEN_ERRCODE, ITEM_TYPE_TEXT, MESSAGE_TYPE_BOT,
	clientVersion, appHeaders, botHeaders, randomWechatUin, redirectBase, trustedBaseUrl, statusFields,
	requestQrCode, pollQrStatus, baseInfo, clientId, quoteLargeIntegers, readJsonLossless,
};

export {
	APP_ID, BOT_AGENT, BOT_TYPE, FIXED_BASE_URL, ID_FIELDS, ITEM_TYPE_TEXT, LOGIN_PHASES,
	LOGIN_TTL_MS, LoginSession, MAX_QR_REFRESH, MESSAGE_TYPE_BOT, POLL_INTERVAL_MS,
	QR_LONG_POLL_TIMEOUT_MS, STALE_TOKEN_ERRCODE, STATUS_PHASES, UPDATES_TIMEOUT_MS,
	appHeaders, baseInfo, botHeaders, clientId, clientVersion, fetchTypingTicket,
	pollQrStatus, pollUpdates, quoteLargeIntegers, randomWechatUin, readJsonLossless,
	redirectBase, requestQrCode, sendText, sendTyping, statusFields, trustedBaseUrl, testing,
};
