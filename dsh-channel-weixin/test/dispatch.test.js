import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { handleInbound } from '../lib/dispatch.js';
import { readBindings } from '../lib/storage.js';
import * as storage from '../lib/storage.js';

/** A live-agent stand-in. */
function agent(id, cwd = '') {
	return { session: { header: { id, cwd, createdAt: 1 } } };
}

/** Dispatch context: a temp storage root plus service stand-ins. */
function context({ roots = [], live = {}, create, resume, persistence } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'channel-weixin-dispatch-'));
	const created = [];
	const agents = {
		roots: () => [...roots],
		get: (id) => live[id],
		create: create ?? (async (options) => {
			created.push(options);
			return { agent: agent('session-created', options.meta.cwd) };
		}),
		resume: resume ?? (async () => { throw new Error('resume not expected'); }),
	};
	const applied = [];
	return {
		root,
		created,
		applied,
		agents,
		permissionPresets: { set: (session, name) => applied.push({ session, name }) },
		persistence,
		storage,
		services: {
			agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
			agentPresets: {
				defaultId: 'standard',
				resolve: async () => ({ id: 'standard', name: 'Standard' }),
				mount: async () => {},
				list: async () => [{ id: 'standard', name: 'Standard' }, { id: 'plan', name: 'Plan' }],
			},
		},
		dispose() { rmSync(root, { recursive: true, force: true }); },
	};
}

/** Shorthand for one dispatch call. */
function send(ctx, text, peer = 'peer-a') {
	return handleInbound({ ...ctx, text, peer });
}

test('a plain message becomes a task and touches no binding', async () => {
	const ctx = context();
	try {
		const result = await send(ctx, '帮我看一下这个报错');
		assert.deepEqual(result, { action: 'task', text: '帮我看一下这个报错' });
		assert.deepEqual(readBindings(ctx.root), {});
	} finally {
		ctx.dispose();
	}
});

test('empty input is ignored', async () => {
	const ctx = context();
	try {
		assert.deepEqual(await send(ctx, '   '), { action: 'ignore' });
	} finally {
		ctx.dispose();
	}
});

test('help lists the commands', async () => {
	const ctx = context();
	try {
		const result = await send(ctx, '/help');
		assert.equal(result.action, 'reply');
		assert.equal(result.text.includes('/new <绝对目录>'), true);
		assert.equal(result.bound, undefined);
	} finally {
		ctx.dispose();
	}
});

test('an unknown command is refused with help instead of becoming a task', async () => {
	const ctx = context();
	try {
		const result = await send(ctx, '/stpo');
		assert.equal(result.action, 'reply');
		assert.match(result.text, /未知命令 \/stpo/);
		assert.equal(result.text.includes('/help'), true);
	} finally {
		ctx.dispose();
	}
});

test('the escape hatch sends slash-leading text as a task', async () => {
	const ctx = context();
	try {
		assert.deepEqual(await send(ctx, '//etc/hosts 是什么'), { action: 'task', text: '/etc/hosts 是什么' });
	} finally {
		ctx.dispose();
	}
});

test('every command from §7.1 is implemented rather than deferred', async () => {
	const ctx = context();
	try {
		storage.writeBinding(ctx.root, 'peer-a', { sessionId: 'session-1' });
		ctx.agents.get = () => ({ status: 'idle', inbox: { nextTurn: [], nextStep: [], remove: () => true }, cancel: () => {}, session: {} });
		ctx.services = { llm: { listProviders: () => [], listModels: async () => [] } };
		for (const text of ['/stop', '/queue', '/models', '/model', '/usage', '/search 关键词']) {
			const result = await send(ctx, text);
			assert.equal(result.action, 'reply', `${text} did not answer`);
			assert.equal(/尚未实现/.test(result.text), false, `${text} is still deferred: ${result.text}`);
		}
	} finally {
		ctx.dispose();
	}
});

test('/stop requires a binding and reports the pause honestly', async () => {
	const ctx = context();
	try {
		const unbound = await send(ctx, '/stop');
		assert.match(unbound.text, /尚未绑定 DSH 会话/);
		storage.writeBinding(ctx.root, 'peer-a', { sessionId: 'session-1' });
		const cancelled = [];
		ctx.agents.get = () => ({
			status: 'running',
			inbox: { nextTurn: [{ id: 'x', content: [] }], nextStep: [], remove: () => true },
			cancel: (cause, options) => cancelled.push({ cause, options }),
		});
		const stopped = await send(ctx, '/stop');
		assert.equal(stopped.action, 'reply');
		assert.equal(stopped.paused, true);
		assert.match(stopped.text, /已请求取消当前任务/);
		assert.match(stopped.text, /队列保留 1 项/);
		assert.match(stopped.text, /取消不等于回滚/);
		assert.match(stopped.text, /\/queue resume/);
		assert.equal(cancelled.length, 1);
		assert.equal(cancelled[0].options.keepInbox, true, 'the queue must be kept, not cleared');
	} finally {
		ctx.dispose();
	}
});

test('/stop on a session that is not live reports that instead of claiming a stop', async () => {
	const ctx = context();
	try {
		storage.writeBinding(ctx.root, 'peer-a', { sessionId: 'session-gone' });
		const result = await send(ctx, '/stop');
		assert.match(result.text, /当前未运行/);
		assert.equal(result.paused, undefined);
	} finally {
		ctx.dispose();
	}
});

test('/queue lists pending items and explains removal and resume', async () => {
	const ctx = context();
	try {
		storage.writeBinding(ctx.root, 'peer-a', { sessionId: 'session-1' });
		ctx.agents.get = () => ({
			status: 'idle',
			inbox: {
				nextTurn: [{ id: 'weixin-m-1', content: [{ type: 'text', text: '第一个任务' }] }],
				nextStep: [],
				remove: () => true,
			},
			cancel: () => {},
		});
		const listed = await send(ctx, '/queue');
		assert.match(listed.text, /待执行 1 项/);
		assert.match(listed.text, /weixin-m-1 · 第一个任务/);
		const removed = await send(ctx, '/queue remove weixin-m-1');
		assert.match(removed.text, /已删除，剩余待执行 0 项/);
		const missing = await send(ctx, '/queue remove nope');
		assert.match(missing.text, /不在待执行队列中/);
		const usage = await send(ctx, '/queue nonsense');
		assert.match(usage.text, /用法：\/queue/);
	} finally {
		ctx.dispose();
	}
});

test('/queue resume reports each outcome distinctly', async () => {
	const ctx = context();
	try {
		storage.writeBinding(ctx.root, 'peer-a', { sessionId: 'session-1' });
		ctx.agents.get = () => ({ status: 'idle', inbox: { nextTurn: [], nextStep: [], remove: () => true } });
		const empty = await send(ctx, '/queue resume');
		assert.match(empty.text, /队列为空/);
		let woken = 0;
		ctx.agents.get = () => ({
			status: 'idle',
			inbox: { nextTurn: [{ id: 'x', content: [] }], nextStep: [], remove: () => true },
			wakeDriver: () => { woken += 1; },
		});
		const resumed = await send(ctx, '/queue resume');
		assert.match(resumed.text, /已继续执行队列/);
		assert.equal(resumed.resumed, true);
		assert.equal(woken, 1);
	} finally {
		ctx.dispose();
	}
});

test('/schedule add refuses vague times and stores an explicit one', async () => {
	const ctx = context();
	try {
		storage.writeBinding(ctx.root, 'peer-a', { sessionId: 'session-1', cwd: 'C:\\w' });
		const vague = await send(ctx, '/schedule add 明天早上 跑测试');
		assert.match(vague.text, /无法解析该时间/);
		assert.match(vague.text, /\+30m/);
		assert.deepEqual(storage.readSchedules(ctx.root).entries, []);
		const created = await send(ctx, '/schedule add +30m 跑测试');
		assert.match(created.text, /已创建定时任务 sched-1/);
		assert.match(created.text, /时区：/);
		assert.match(created.text, /绑定会话：session-1/);
		assert.match(created.text, /不会补跑/);
		const entries = storage.readSchedules(ctx.root).entries;
		assert.equal(entries.length, 1);
		assert.equal(entries[0].peer, 'peer-a');
		assert.equal(entries[0].text, '跑测试');
		assert.equal(entries[0].kind, 'once');
		assert.equal(entries[0].sessionId, 'session-1');
	} finally {
		ctx.dispose();
	}
});

test('/schedule list and remove only touch the calling peer', async () => {
	const ctx = context({
		live: {
			'session-1': { inbox: { nextTurn: [{ id: 'sched-1#0', content: [] }], nextStep: [] } },
		},
	});
	try {
		storage.writeBinding(ctx.root, 'peer-a', { sessionId: 'session-1' });
		storage.writeBinding(ctx.root, 'peer-b', { sessionId: 'session-2' });
		await send(ctx, '/schedule add +30m 我的任务', 'peer-a');
		await send(ctx, '/schedule add +30m 别人的任务', 'peer-b');
		const listed = await send(ctx, '/schedule list', 'peer-a');
		assert.match(listed.text, /我的任务/);
		assert.equal(listed.text.includes('别人的任务'), false, 'a peer must not see another peer schedule');
		const foreign = await send(ctx, '/schedule remove sched-2', 'peer-a');
		assert.match(foreign.text, /没有找到你的定时任务/);
		assert.equal(storage.readSchedules(ctx.root).entries.length, 2);
		storage.writeBinding(ctx.root, 'peer-a', { sessionId: 'session-new' });
		const removed = await send(ctx, '/schedule remove sched-1', 'peer-a');
		assert.match(removed.text, /已删除定时任务 sched-1/);
		assert.match(removed.text, /sched-1#0/);
		assert.match(removed.text, /\/queue remove sched-1#0/);
		assert.deepEqual(storage.readSchedules(ctx.root).entries.map((entry) => entry.id), ['sched-2']);
	} finally {
		ctx.dispose();
	}
});

test('/schedule add before binding explains what is missing', async () => {
	const ctx = context();
	try {
		const result = await send(ctx, '/schedule add +30m 任务');
		assert.match(result.text, /尚未绑定 DSH 会话/);
		assert.deepEqual(storage.readSchedules(ctx.root).entries, []);
	} finally {
		ctx.dispose();
	}
});

test('/agents lists the default/current mode and /agent switches a blank session', async () => {
	const running = agent('session-1', 'C:\\w');
	const ctx = context({ roots: [running], live: { 'session-1': running } });
	try {
		storage.writeBinding(ctx.root, 'peer-a', { sessionId: 'session-1', cwd: 'C:\\w' });
		const selected = [];
		ctx.services = {
			agentPresets: {
				defaultId: 'standard',
				list: async () => [
					{ id: 'standard', name: 'Standard', description: '标准工具模式' },
					{ id: 'plan', name: 'Plan' },
				],
				select: async (_agent, id) => { selected.push(id); return id; },
			},
			sessionProjections: { stateOf: () => 'standard' },
		};
		const listed = await send(ctx, '/agents');
		assert.match(listed.text, /\[默认、当前\] standard/);
		assert.match(listed.text, /plan/);
		const current = await send(ctx, '/agent');
		assert.match(current.text, /当前 Agent 模式：standard/);
		const switched = await send(ctx, '/agent plan');
		assert.match(switched.text, /已切换 Agent 模式：plan/);
		assert.deepEqual(selected, ['plan']);
	} finally {
		ctx.dispose();
	}
});

test('/models lists providers, marks failures, and states the switch semantics', async () => {
	const ctx = context();
	try {
		ctx.services = {
			llm: {
				listProviders: () => [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }],
				listModels: async (id) => {
					if (id === 'beta') throw new Error('unreachable');
					return [{ id: 'a1' }, { id: 'a2' }];
				},
			},
			agentDefaultModel: { currentSelection: () => ({ provider: 'alpha', model: 'a1' }) },
		};
		const result = await send(ctx, '/models');
		assert.match(result.text, /Alpha（alpha）/);
		assert.match(result.text, /a1/);
		assert.match(result.text, /部分提供商枚举失败：beta/);
		assert.match(result.text, /部署默认：alpha\/a1/);
		assert.match(result.text, /从下一条任务生效/);
	} finally {
		ctx.dispose();
	}
});

test('/model reports the current selection, refuses unknown ids, and switches a valid one', async () => {
	const ctx = context();
	try {
		storage.writeBinding(ctx.root, 'peer-a', { sessionId: 'session-1' });
		const appended = [];
		const listeners = [];
		ctx.agents.get = () => ({
			session: { append: (type, data) => { appended.push({ type, data }); } },
			ctx: { on: (event, handler) => { listeners.push({ event, handler }); return () => {}; } },
		});
		ctx.services = {
			llm: { listProviders: () => [{ id: 'alpha', name: 'Alpha' }], listModels: async () => [{ id: 'a1' }] },
			sessionProjections: { stateOf: () => ({ pending: { provider: 'alpha', model: 'a0' }, lastUsed: null }) },
		};
		const current = await send(ctx, '/model');
		assert.match(current.text, /当前模型：alpha\/a0/);
		const unknown = await send(ctx, '/model nope');
		assert.match(unknown.text, /没有该模型：nope/);
		const switched = await send(ctx, '/model alpha/a1');
		assert.match(switched.text, /已切换到 alpha\/a1/);
		assert.match(switched.text, /当前任务不受影响/);
		assert.deepEqual(appended, [{ type: 'model/selection', data: { provider: 'alpha', model: 'a1' } }]);
		assert.equal(listeners.length, 2);
		assert.deepEqual(listeners.map((listener) => listener.event), ['system-prompt/assemble', 'agent/request']);
	} finally {
		ctx.dispose();
	}
});

test('/model and /usage refuse when the bound session is not live', async () => {
	const ctx = context();
	try {
		storage.writeBinding(ctx.root, 'peer-a', { sessionId: 'session-gone' });
		ctx.services = { llm: { listProviders: () => [], listModels: async () => [] } };
		assert.match((await send(ctx, '/model alpha/a1')).text, /当前未运行/);
		assert.match((await send(ctx, '/usage')).text, /当前未运行/);
	} finally {
		ctx.dispose();
	}
});

test('/usage reports buckets and the aggregation limitation', async () => {
	const ctx = context();
	try {
		storage.writeBinding(ctx.root, 'peer-a', { sessionId: 'session-1' });
		ctx.agents.get = () => ({ session: {} });
		ctx.services = {
			sessionProjections: {
				stateOf: () => ({ totals: { uncachedInputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 2, outputTokens: 3 } }),
			},
		};
		const result = await send(ctx, '/usage');
		assert.match(result.text, /本会话累计 Token：20/);
		assert.match(result.text, /缓存读取 5/);
		assert.match(result.text, /跨会话汇总不可用/);
	} finally {
		ctx.dispose();
	}
});

test('/search reports results, emptiness, and unavailable search distinctly', async () => {
	const ctx = context();
	try {
		const hits = await send(ctx, '/search 关键词');
		assert.match(hits.text, /未启用会话检索/, 'without the service the reply says so');
		ctx.services = {
			sessionQuery: {
				searchSessions: async () => ({
					items: [{ header: { id: 'session-abcdef12', cwd: 'C:\\w' }, bestMatch: { sessionId: 'session-abcdef12', type: 'user/message', snippet: '关键词在这里' } }],
				}),
			},
		};
		const found = await send(ctx, '/search 关键词');
		assert.match(found.text, /abcdef12/);
		assert.match(found.text, /关键词在这里/);
		ctx.services = { sessionQuery: { searchSessions: async () => ({ items: [] }) } };
		assert.match((await send(ctx, '/search 关键词')).text, /没有找到包含「关键词」/);
		assert.match((await send(ctx, '/search')).text, /命令缺少参数：\/search <关键词>/);
	} finally {
		ctx.dispose();
	}
});

test('/new creates a session, applies full access, and binds the peer', async () => {
	const ctx = context();
	try {
		const dir = mkdtempSync(join(tmpdir(), 'channel-weixin-dir-'));
		try {
			const result = await send(ctx, `/new ${dir}`);
			assert.equal(result.action, 'reply');
			assert.equal(result.bound, true);
			assert.match(result.text, /已新建并绑定会话/);
			assert.match(result.text, /完全权限/);
			assert.equal(ctx.created.length, 1);
			assert.match(ctx.created[0].sessionId, /^session-[0-9a-f-]{36}$/);
			assert.deepEqual(ctx.created[0].meta, { cwd: dir, agentPreset: 'standard' });
			assert.deepEqual(ctx.created[0].agentOptions, { provider: 'deepseek', model: 'deepseek-chat' });
			assert.equal(typeof ctx.created[0].setup, 'function');
			assert.equal(ctx.applied.length, 1);
			assert.equal(ctx.applied[0].name, 'danger-full-access');
			assert.equal(ctx.applied[0].session.header.id, 'session-created');
			const bindings = readBindings(ctx.root);
			assert.equal(bindings['peer-a'].sessionId, 'session-created');
			assert.equal(bindings['peer-a'].cwd, dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	} finally {
		ctx.dispose();
	}
});

test('/new with a bad directory reports why and leaves the binding untouched', async () => {
	const ctx = context();
	try {
		storage.writeBinding(ctx.root, 'peer-a', { sessionId: 'session-existing', cwd: 'C:\\old' });
		const relative = await send(ctx, '/new relative\\dir');
		assert.match(relative.text, /绝对路径/);
		const missing = await send(ctx, '/new C:\\definitely\\not\\here\\for\\tests');
		assert.match(missing.text, /不存在或不可访问/);
		const noArg = await send(ctx, '/new');
		assert.match(noArg.text, /缺少参数/);
		assert.equal(ctx.created.length, 0);
		const bindings = readBindings(ctx.root);
		assert.equal(bindings['peer-a'].sessionId, 'session-existing');
		assert.equal(bindings['peer-a'].cwd, 'C:\\old');
	} finally {
		ctx.dispose();
	}
});

test('a failed creation reports the reason and keeps the old binding', async () => {
	const ctx = context({ create: async () => { throw new Error('duplicate id'); } });
	try {
		storage.writeBinding(ctx.root, 'peer-a', { sessionId: 'session-old' });
		const dir = mkdtempSync(join(tmpdir(), 'channel-weixin-dir-'));
		try {
			const result = await send(ctx, `/new ${dir}`);
			assert.match(result.text, /会话创建失败，原绑定未改变/);
			assert.match(result.text, /duplicate id/);
			assert.equal(readBindings(ctx.root)['peer-a'].sessionId, 'session-old');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	} finally {
		ctx.dispose();
	}
});

test('/sessions lists switchable sessions and marks the bound one', async () => {
	const ctx = context({ roots: [agent('session-aaaa1111', 'C:\\w'), agent('session-bbbb2222', 'D:\\x')] });
	try {
		storage.writeBinding(ctx.root, 'peer-a', { sessionId: 'session-bbbb2222', cwd: 'D:\\x' });
		const result = await send(ctx, '/sessions');
		assert.equal(result.text.includes('* bbbb2222 · D:\\x'), true);
		assert.equal(result.text.includes('  aaaa1111 · C:\\w'), true);
	} finally {
		ctx.dispose();
	}
});

test('/sessions with nothing to switch to suggests /new', async () => {
	const ctx = context();
	try {
		const result = await send(ctx, '/sessions');
		assert.match(result.text, /没有可切换的会话/);
		assert.equal(result.text.includes('/new'), true);
	} finally {
		ctx.dispose();
	}
});

test('/use switches to a live session and binds it', async () => {
	const running = agent('session-aaaa1111', 'C:\\w');
	const ctx = context({ roots: [running], live: { 'session-aaaa1111': running } });
	try {
		const result = await send(ctx, '/use aaaa1111');
		assert.equal(result.bound, true);
		assert.match(result.text, /已切换到会话：aaaa1111/);
		assert.equal(readBindings(ctx.root)['peer-a'].sessionId, 'session-aaaa1111');
	} finally {
		ctx.dispose();
	}
});

test('/use reports an unknown session and keeps the current binding', async () => {
	const ctx = context({ roots: [agent('session-aaaa1111')] });
	try {
		storage.writeBinding(ctx.root, 'peer-a', { sessionId: 'session-aaaa1111' });
		const result = await send(ctx, '/use nope');
		assert.match(result.text, /没有找到该会话/);
		assert.equal(readBindings(ctx.root)['peer-a'].sessionId, 'session-aaaa1111');
	} finally {
		ctx.dispose();
	}
});

test('/use reports an ambiguous short id', async () => {
	const ctx = context({ roots: [agent('session-x-same1234'), agent('session-y-same1234')] });
	try {
		const result = await send(ctx, '/use same1234');
		assert.match(result.text, /短 ID 不唯一/);
		assert.equal(readBindings(ctx.root)['peer-a'], undefined);
	} finally {
		ctx.dispose();
	}
});

test('/cwd reports the binding, and says so when there is none', async () => {
	const ctx = context();
	try {
		const none = await send(ctx, '/cwd');
		assert.match(none.text, /尚未绑定会话/);
		storage.writeBinding(ctx.root, 'peer-a', { sessionId: 'session-1', cwd: 'C:\\work' });
		const bound = await send(ctx, '/cwd');
		assert.match(bound.text, /session-1/);
		assert.match(bound.text, /C:\\work/);
	} finally {
		ctx.dispose();
	}
});

test('two peers keep independent bindings', async () => {
	const one = agent('session-one-1111', 'C:\\one');
	const two = agent('session-two-2222', 'C:\\two');
	const ctx = context({ roots: [one, two], live: { 'session-one-1111': one, 'session-two-2222': two } });
	try {
		await send(ctx, '/use one-1111', 'peer-a');
		await send(ctx, '/use two-2222', 'peer-b');
		const bindings = readBindings(ctx.root);
		assert.equal(bindings['peer-a'].sessionId, 'session-one-1111');
		assert.equal(bindings['peer-b'].sessionId, 'session-two-2222');
		const cwdA = await send(ctx, '/cwd', 'peer-a');
		assert.match(cwdA.text, /C:\\one/);
	} finally {
		ctx.dispose();
	}
});

test('an oversized message is refused with its length', async () => {
	const ctx = context();
	try {
		const result = await send(ctx, 'x'.repeat(5000));
		assert.equal(result.action, 'reply');
		assert.match(result.text, /消息过长（5000 字符）/);
	} finally {
		ctx.dispose();
	}
});
