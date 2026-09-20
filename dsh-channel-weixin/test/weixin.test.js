import assert from 'node:assert/strict';
import test from 'node:test';

import {
	LoginSession, appHeaders, botHeaders, clientVersion, pollQrStatus, randomWechatUin,
	redirectBase, requestQrCode, statusFields, testing,
} from '../lib/weixin.js';

/** A fetch stand-in answering one canned JSON body and recording the request. */
function fakeFetch(body, { ok = true, status = 200, raw } = {}) {
	const calls = [];
	const impl = async (url, options) => {
		calls.push({ url: String(url), options });
		const text = raw !== undefined ? raw : JSON.stringify(body);
		return {
			ok,
			status,
			/* The plugin reads the raw body so uint64 identifiers survive parsing. */
			text: async () => text,
			json: async () => JSON.parse(text),
		};
	};
	impl.calls = calls;
	return impl;
}

/** A fetch stand-in that always fails, for transport-error paths. */
function failingFetch(message = 'socket hang up') {
	const calls = [];
	const impl = async (url, options) => {
		calls.push({ url: String(url), options });
		throw new Error(message);
	};
	impl.calls = calls;
	return impl;
}

/** Drive a session through a scripted list of status answers. */
function sessionWith(answers, { now = () => 1000, baseUrl } = {}) {
	const queue = [...answers];
	const answer = (body) => ({
		ok: true,
		status: 200,
		text: async () => JSON.stringify(body),
		json: async () => body,
	});
	const impl = async (url) => {
		if (String(url).includes('get_bot_qrcode')) {
			return answer({ qrcode: 'secret-qr', qrcode_img_content: 'https://weixin.qq.com/x/abc' });
		}
		const next = queue.shift() ?? { status: 'wait' };
		if (next instanceof Error) throw next;
		return answer(next);
	};
	return new LoginSession({ fetchImpl: impl, version: '1.2.3', now, baseUrl });
}

test('client version encodes 0x00MMNNPP', () => {
	assert.equal(clientVersion('1.2.3'), String((1 << 16) | (2 << 8) | 3));
	assert.equal(clientVersion('0.0.0'), '0');
	assert.equal(clientVersion(undefined), '0');
	assert.equal(clientVersion('2.4.9'), String((2 << 16) | (4 << 8) | 9));
});

test('application headers carry the protocol identity and no authorization', () => {
	const headers = appHeaders('1.2.3');
	assert.equal(headers['iLink-App-Id'], 'bot');
	assert.equal(headers['iLink-App-ClientVersion'], String((1 << 16) | (2 << 8) | 3));
	assert.equal(headers.Authorization, undefined);
	assert.equal(headers['User-Agent'], undefined);
});

test('bot headers add the bearer credential and a base64 UIN', () => {
	const headers = botHeaders('token-1', '0.1.0', () => 0.5);
	assert.equal(headers.Authorization, 'Bearer token-1');
	assert.equal(headers.AuthorizationType, 'ilink_bot_token');
	assert.equal(headers['X-WECHAT-UIN'], randomWechatUin(() => 0.5));
	assert.equal(Buffer.from(headers['X-WECHAT-UIN'], 'base64').toString('utf8'), String(Math.floor(0.5 * 0xffffffff) >>> 0));
});

test('a redirect host is accepted only inside the WeChat domain', () => {
	assert.equal(redirectBase('sz.weixin.qq.com'), 'https://sz.weixin.qq.com');
	assert.equal(redirectBase('WEIXIN.QQ.COM'), 'https://weixin.qq.com');
	assert.equal(redirectBase('evil.example.com'), undefined);
	assert.equal(redirectBase('weixin.qq.com.evil.example'), undefined);
	assert.equal(redirectBase('https://weixin.qq.com'), undefined);
	assert.equal(redirectBase('weixin.qq.com:8443'), undefined);
	assert.equal(redirectBase('weixin.qq.com/path'), undefined);
	assert.equal(redirectBase(''), undefined);
	assert.equal(redirectBase(undefined), undefined);
});

test('status fields are whitelisted out of a hostile answer', () => {
	const picked = statusFields({
		status: 'confirmed',
		bot_token: 'token',
		ilink_bot_id: 'bot-1',
		ilink_user_id: 'user-1',
		baseurl: 'https://sz.weixin.qq.com',
		redirect_host: 'sz.weixin.qq.com',
		evil: 'ignored',
		nested: { token: 'ignored' },
	});
	assert.deepEqual(picked, {
		bot_token: 'token',
		ilink_bot_id: 'bot-1',
		ilink_user_id: 'user-1',
		baseurl: 'https://sz.weixin.qq.com',
		redirect_host: 'sz.weixin.qq.com',
	});
	assert.deepEqual(statusFields(null), {});
});

test('the QR request posts the documented shape and returns both fields', async () => {
	const fetchImpl = fakeFetch({ qrcode: 'secret', qrcode_img_content: 'https://weixin.qq.com/x/1' });
	const result = await requestQrCode({ fetchImpl, version: '0.1.0' });
	assert.equal(result.qrcode, 'secret');
	assert.equal(result.qrPayload, 'https://weixin.qq.com/x/1');
	const [call] = fetchImpl.calls;
	assert.equal(call.url, 'https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3');
	assert.equal(call.options.method, 'POST');
	assert.deepEqual(JSON.parse(call.options.body), { local_token_list: [] });
	assert.equal(call.options.headers['iLink-App-Id'], 'bot');
});

test('a QR answer missing either field is rejected', async () => {
	await assert.rejects(
		() => requestQrCode({ fetchImpl: fakeFetch({ qrcode: 'only-secret' }), version: '0.1.0' }),
		/qrcode_img_content/,
	);
});

test('an unknown login status is rejected instead of mapped', async () => {
	await assert.rejects(
		() => pollQrStatus({ fetchImpl: fakeFetch({ status: 'surprise' }), version: '0.1.0', qrcode: 'q' }),
		/unknown login status/,
	);
});

test('the verification code rides the status query of the next poll', async () => {
	const fetchImpl = fakeFetch({ status: 'scaned' });
	await pollQrStatus({ fetchImpl, version: '0.1.0', qrcode: 'q r', verifyCode: '1234' });
	assert.equal(fetchImpl.calls[0].url.includes('qrcode=q+r'), true);
	assert.equal(fetchImpl.calls[0].url.includes('verify_code=1234'), true);
});

test('start publishes the scannable payload but never the polling secret', async () => {
	const session = sessionWith([]);
	const snapshot = await session.start();
	assert.equal(snapshot.phase, 'login-pending');
	assert.equal(snapshot.qrPayload, 'https://weixin.qq.com/x/abc');
	assert.equal(JSON.stringify(snapshot).includes('secret-qr'), false);
});

test('a transport failure at start is reported without leaving a pending login', async () => {
	const session = new LoginSession({ fetchImpl: failingFetch('offline'), version: '0.1.0', now: () => 0 });
	const snapshot = await session.start();
	assert.equal(snapshot.phase, 'error');
	assert.equal(snapshot.qrPayload, '');
	assert.match(snapshot.error, /二维码获取失败/);
});

test('scan then confirm yields credentials and clears the secret and payload', async () => {
	const session = sessionWith([
		{ status: 'wait' },
		{ status: 'scaned' },
		{ status: 'confirmed', bot_token: 'tok', ilink_bot_id: 'bot-9', ilink_user_id: 'user-9', baseurl: 'https://sz.weixin.qq.com' },
	]);
	await session.start();
	assert.equal((await session.pollOnce()).phase, 'login-pending');
	assert.equal((await session.pollOnce()).phase, 'scanned');
	const confirmed = await session.pollOnce();
	assert.equal(confirmed.phase, 'connected');
	assert.deepEqual(confirmed.account, {
		botToken: 'tok', botId: 'bot-9', userId: 'user-9', baseUrl: 'https://sz.weixin.qq.com',
	});
	assert.equal(confirmed.qrPayload, '');
	assert.equal(session.active, false);
});

test('a confirmation without a credential is an error, not a bound connection', async () => {
	const session = sessionWith([{ status: 'confirmed', ilink_bot_id: 'bot-9' }]);
	await session.start();
	const snapshot = await session.pollOnce();
	assert.equal(snapshot.phase, 'error');
	assert.equal(snapshot.account, null);
	assert.match(snapshot.error, /未返回登录凭证/);
});

test('a confirmation without the scanned user identity is rejected', async () => {
	const session = sessionWith([{ status: 'confirmed', bot_token: 'tok' }]);
	await session.start();
	const snapshot = await session.pollOnce();
	assert.equal(snapshot.phase, 'error');
	assert.equal(snapshot.account, null);
	assert.match(snapshot.error, /无法安全限制发送者/);
});

test('an untrusted confirmed API base is rejected before credentials are stored', async () => {
	const session = sessionWith([{ status: 'confirmed', bot_token: 'tok', ilink_user_id: 'user-9', baseurl: 'https://attacker.example' }]);
	await session.start();
	const snapshot = await session.pollOnce();
	assert.equal(snapshot.phase, 'error');
	assert.equal(snapshot.account, null);
	assert.match(snapshot.error, /不可信的 API 地址/);
});

test('a missing baseurl falls back to the fixed login base', async () => {
	const session = sessionWith([{ status: 'confirmed', bot_token: 'tok', ilink_user_id: 'user-9' }]);
	await session.start();
	const snapshot = await session.pollOnce();
	assert.equal(snapshot.account.baseUrl, testing.FIXED_BASE_URL);
});

test('a verification code is required, validated, and retired after acceptance', async () => {
	const session = sessionWith([{ status: 'need_verifycode' }, { status: 'scaned' }, { status: 'scaned' }]);
	await session.start();
	assert.equal((await session.pollOnce()).phase, 'verify-required');
	assert.equal(session.submitVerifyCode('12'), false);
	assert.equal(session.submitVerifyCode('abcd'), false);
	assert.equal(session.submitVerifyCode('1234'), true);
	assert.equal((await session.pollOnce()).phase, 'scanned');
	/* The accepted code is retired, so a later poll cannot resend it. */
	assert.equal(session.pendingVerifyCode, '');
	assert.equal((await session.pollOnce()).phase, 'scanned');
});

test('an unknown code is never sent and never enters the snapshot', async () => {
	const session = sessionWith([{ status: 'need_verifycode' }]);
	await session.start();
	const snapshot = await session.pollOnce();
	assert.equal(snapshot.verifyCodeRequired, true);
	assert.equal(JSON.stringify(snapshot).includes('verify'), true);
	assert.equal(snapshot.verifyCode, undefined);
});

test('a rejected verification code is retired instead of being resent every poll', async () => {
	const urls = [];
	const answers = [
		{ status: 'need_verifycode' },
		{ status: 'need_verifycode' },
		{ status: 'need_verifycode' },
		{ status: 'wait' },
	];
	const impl = async (url) => {
		urls.push(String(url));
		const body = String(url).includes('get_bot_qrcode')
			? { qrcode: 'secret-qr', qrcode_img_content: 'https://weixin.qq.com/x/abc' }
			: (answers.shift() ?? { status: 'wait' });
		return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
	};
	const session = new LoginSession({ fetchImpl: impl, version: '1.0.0', now: () => 0 });
	await session.start();
	await session.pollOnce();
	assert.equal(session.submitVerifyCode('1234'), true);
	const rejected = await session.pollOnce();
	assert.equal(rejected.phase, 'verify-required');
	assert.match(rejected.error, /验证码不正确/);
	assert.equal(session.pendingVerifyCode, '', 'a rejected code must not stay armed');
	/* The next poll carries no verify_code, and the one after that neither. */
	await session.pollOnce();
	await session.pollOnce();
	const statusCalls = urls.filter((url) => url.includes('get_qrcode_status'));
	assert.equal(statusCalls.filter((url) => url.includes('verify_code')).length, 1, 'exactly one poll may carry the guessed code');
	/* Re-entering the state without a code clears the stale error. */
	const recovered = await session.pollOnce();
	assert.equal(recovered.error, '');
});

test('a code typed before the server asks is held, not spent on an unrelated poll', async () => {
	const urls = [];
	const answers = [{ status: 'wait' }, { status: 'need_verifycode' }, { status: 'scaned' }];
	const impl = async (url) => {
		urls.push(String(url));
		const body = String(url).includes('get_bot_qrcode')
			? { qrcode: 'secret-qr', qrcode_img_content: 'https://weixin.qq.com/x/abc' }
			: (answers.shift() ?? { status: 'wait' });
		return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
	};
	const statusUrl = (index) => urls.filter((url) => url.includes('get_qrcode_status'))[index];
	const session = new LoginSession({ fetchImpl: impl, version: '1.0.0', now: () => 0 });
	await session.start();
	/* The user types the code while the page is still waiting for a scan. */
	assert.equal(session.submitVerifyCode('5678'), true);
	await session.pollOnce();
	assert.equal(statusUrl(0).includes('verify_code'), false, 'an unrequested code must not be sent');
	assert.equal(session.pendingVerifyCode, '5678', 'the code stays armed while nothing asks for it');
	/* This poll is what learns that a code is wanted; the request itself cannot carry it. */
	assert.equal((await session.pollOnce()).phase, 'verify-required');
	assert.equal(statusUrl(1).includes('verify_code'), false);
	/* From the next poll on, the armed code rides along. */
	await session.pollOnce();
	assert.equal(statusUrl(2).includes('verify_code=5678'), true);
	assert.equal(session.pendingVerifyCode, '', 'an accepted code is retired');
});

test('a correctly accepted code is retired and the login continues', async () => {
	const session = sessionWith([{ status: 'need_verifycode' }, { status: 'scaned' }, { status: 'confirmed', bot_token: 'tok', ilink_user_id: 'user-9' }]);
	await session.start();
	await session.pollOnce();
	session.submitVerifyCode('4321');
	assert.equal((await session.pollOnce()).phase, 'scanned');
	assert.equal((await session.pollOnce()).phase, 'connected');
});

test('too many wrong codes end the attempt with a clear error', async () => {
	const session = sessionWith([{ status: 'verify_code_blocked' }]);
	await session.start();
	const snapshot = await session.pollOnce();
	assert.equal(snapshot.phase, 'error');
	assert.match(snapshot.error, /验证码错误次数过多/);
});

test('an expired QR code is refreshed, and the refresh budget is bounded', async () => {
	const session = sessionWith([
		{ status: 'expired' }, { status: 'expired' }, { status: 'expired' }, { status: 'expired' },
	]);
	await session.start();
	assert.equal((await session.pollOnce()).phase, 'login-pending');
	assert.equal(session.refreshCount, 1);
	assert.equal((await session.pollOnce()).phase, 'login-pending');
	assert.equal(session.refreshCount, 2);
	assert.equal((await session.pollOnce()).phase, 'login-pending');
	assert.equal(session.refreshCount, 3);
	const exhausted = await session.pollOnce();
	assert.equal(exhausted.phase, 'error');
	assert.match(exhausted.error, /多次失效/);
});

test('a trusted redirect moves polling to the new host', async () => {
	const session = sessionWith([{ status: 'scaned_but_redirect', redirect_host: 'sz.weixin.qq.com' }]);
	await session.start();
	await session.pollOnce();
	assert.equal(session.baseUrl, 'https://sz.weixin.qq.com');
});

test('an untrusted redirect ends the attempt instead of leaking the secret', async () => {
	const session = sessionWith([{ status: 'scaned_but_redirect', redirect_host: 'evil.example.com' }]);
	await session.start();
	const snapshot = await session.pollOnce();
	assert.equal(snapshot.phase, 'error');
	assert.match(snapshot.error, /不可信的重定向/);
});

test('binded_redirect never counts as a local connection', async () => {
	const session = sessionWith([{ status: 'binded_redirect' }]);
	await session.start();
	const snapshot = await session.pollOnce();
	assert.equal(snapshot.phase, 'error');
	assert.equal(snapshot.account, null);
	assert.match(snapshot.error, /已绑定其他接入端/);
});

test('a network failure during polling keeps the login pending', async () => {
	const session = sessionWith([new Error('timeout')]);
	await session.start();
	const snapshot = await session.pollOnce();
	assert.equal(snapshot.phase, 'login-pending');
	assert.match(snapshot.error, /状态查询失败/);
	assert.equal(session.active, true);
});

test('a locally expired attempt refreshes instead of polling forever', async () => {
	let clock = 0;
	const session = sessionWith([], { now: () => clock });
	await session.start();
	clock = testing.LOGIN_TTL_MS + 1;
	const snapshot = await session.pollOnce();
	assert.equal(session.refreshCount, 1);
	assert.equal(snapshot.phase, 'login-pending');
});

test('cancel returns the attempt to idle and drops both secrets', async () => {
	const session = sessionWith([]);
	await session.start();
	const snapshot = session.cancel();
	assert.equal(snapshot.phase, 'idle');
	assert.equal(snapshot.qrPayload, '');
	assert.equal(session.qrcode, '');
});
