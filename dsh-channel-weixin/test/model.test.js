import assert from 'node:assert/strict';
import test from 'node:test';

import {
	currentSelection, defaultSelection, installModelOverride, listModels, resolveModelToken, selectModel,
} from '../lib/model.js';
import { formatCount, searchHistory, sessionUsage, truncate } from '../lib/usage.js';

/** An `llm` service stand-in over a fixed catalogue. */
function llmService(catalogue, { failOn } = {}) {
	return {
		listProviders: () => Object.keys(catalogue).map((id) => ({ id, name: id.toUpperCase() })),
		listModels: async (id) => {
			if (id === failOn) throw new Error('enumeration failed');
			return (catalogue[id] ?? []).map((model) => ({ id: model }));
		},
	};
}

/** A session stand-in recording appended events. */
function sessionStub() {
	const appended = [];
	return { appended, append: (type, data) => { appended.push({ type, data }); return { seq: appended.length }; } };
}

/** An agent stand-in with a scoped context recording listeners. */
function agentStub() {
	const listeners = [];
	const session = sessionStub();
	return {
		session,
		listeners,
		ctx: { on: (event, handler) => { listeners.push({ event, handler }); return () => listeners.splice(listeners.indexOf(handler), 1); } },
	};
}

test('the catalogue groups models by provider and isolates a failing provider', async () => {
	const catalogue = await listModels({ llm: llmService({ alpha: ['a1', 'a2'], beta: ['b1'] }) });
	assert.deepEqual(catalogue.providers.map((entry) => entry.id), ['alpha', 'beta']);
	assert.deepEqual(catalogue.providers[0].models, ['a1', 'a2']);
	assert.equal(catalogue.providers[0].name, 'ALPHA');
	const isolated = await listModels({ llm: llmService({ alpha: ['a1'], beta: ['b1'] }, { failOn: 'beta' }) });
	assert.deepEqual(isolated.providers.map((entry) => entry.id), ['alpha']);
	assert.deepEqual(isolated.failures, [{ provider: 'beta', reason: 'enumeration failed' }]);
});

test('a missing llm service yields an empty catalogue rather than throwing', async () => {
	assert.deepEqual(await listModels({}), { providers: [], failures: [], default: undefined });
});

test('the deployment default route is reported when available', async () => {
	const catalogue = await listModels({
		llm: llmService({ alpha: ['a1'] }),
		agentDefaultModel: { currentSelection: () => ({ provider: 'alpha', model: 'a1' }) },
	});
	assert.deepEqual(catalogue.default, { provider: 'alpha', model: 'a1' });
	assert.equal(defaultSelection(undefined), undefined);
	assert.equal(defaultSelection({ currentSelection: () => { throw new Error('x'); } }), undefined);
});

test('a bare model id resolves when unique and is refused when ambiguous', () => {
	const providers = [{ id: 'alpha', models: ['shared', 'only-a'] }, { id: 'beta', models: ['shared', 'only-b'] }];
	assert.deepEqual(resolveModelToken(providers, 'only-a'), { ok: true, selection: { provider: 'alpha', model: 'only-a' } });
	const ambiguous = resolveModelToken(providers, 'shared');
	assert.equal(ambiguous.ok, false);
	assert.equal(ambiguous.reason, 'ambiguous');
	assert.deepEqual(ambiguous.candidates, ['alpha/shared', 'beta/shared']);
});

test('a qualified reference resolves, and unknown providers or models are refused with candidates', () => {
	const providers = [{ id: 'alpha', models: ['a1'] }];
	assert.deepEqual(resolveModelToken(providers, 'alpha/a1'), { ok: true, selection: { provider: 'alpha', model: 'a1' } });
	const unknownProvider = resolveModelToken(providers, 'gamma/a1');
	assert.equal(unknownProvider.reason, 'provider-unknown');
	assert.deepEqual(unknownProvider.candidates, ['alpha']);
	const unknownModel = resolveModelToken(providers, 'alpha/nope');
	assert.equal(unknownModel.reason, 'model-unavailable');
	assert.deepEqual(unknownModel.candidates, ['a1']);
	assert.equal(resolveModelToken(providers, '').reason, 'model-missing');
});

test('a model id containing a slash still resolves against its provider', () => {
	const providers = [{ id: 'alpha', models: ['org/model-v2'] }];
	assert.deepEqual(resolveModelToken(providers, 'alpha/org/model-v2'), { ok: true, selection: { provider: 'alpha', model: 'org/model-v2' } });
});

test('the current selection prefers the pending intent over the last used route', () => {
	const session = sessionStub();
	const projections = {
		stateOf: (_session, key) => (key === 'modelSelection' ? { pending: { provider: 'p', model: 'pending' }, lastUsed: { provider: 'q', model: 'used' } } : undefined),
	};
	assert.deepEqual(currentSelection({ sessionProjections: projections, session }), { provider: 'p', model: 'pending' });
	const onlyUsed = { stateOf: () => ({ pending: null, lastUsed: { provider: 'q', model: 'used' } }) };
	assert.deepEqual(currentSelection({ sessionProjections: onlyUsed, session }), { provider: 'q', model: 'used' });
	assert.equal(currentSelection({ sessionProjections: { stateOf: () => undefined }, session }), undefined);
	assert.equal(currentSelection({}), undefined);
});

test('selecting records the durable intent and installs the live override', () => {
	const agent = agentStub();
	const result = selectModel({ agent, selection: { provider: 'alpha', model: 'a1' } });
	assert.equal(result.ok, true);
	assert.deepEqual(agent.session.appended, [{ type: 'model/selection', data: { provider: 'alpha', model: 'a1' } }]);
	assert.equal(agent.listeners.length, 2);
	assert.deepEqual(agent.listeners.map((listener) => listener.event), ['system-prompt/assemble', 'agent/request']);
});

test('the override replaces the route after the normal resolution runs', async () => {
	const listeners = [];
	const agentCtx = { on: (event, handler) => { listeners.push({ event, handler }); return () => {}; } };
	installModelOverride(agentCtx, { provider: 'alpha', model: 'a1', reasoningEffort: 'high' });
	const assembly = listeners.find((listener) => listener.event === 'system-prompt/assemble');
	const request = listeners.find((listener) => listener.event === 'agent/request');
	const rendered = await assembly.handler({}, {}, async () => ({ text: 'prompt', variables: { cwd: 'C:\\w' } }));
	assert.deepEqual(rendered.variables, { cwd: 'C:\\w', provider: 'alpha', model: 'a1' });
	const resolved = await request.handler({}, async () => ({ provider: 'old', model: 'old', temperature: 0.2 }));
	assert.deepEqual(resolved, { provider: 'alpha', model: 'a1', temperature: 0.2, reasoningEffort: 'high' });
	const noEffort = [];
	installModelOverride({ on: (event, handler) => { noEffort.push({ event, handler }); return () => {}; } }, { provider: 'beta', model: 'b1' });
	const plain = await noEffort.find((listener) => listener.event === 'agent/request').handler({}, async () => ({ provider: 'x', model: 'y' }));
	assert.deepEqual(plain, { provider: 'beta', model: 'b1' });
});

test('a switch drops the previous model\'s reasoning effort unless the new one names it', async () => {
	const listeners = [];
	installModelOverride({ on: (_event, handler) => { listeners.push(handler); return () => {}; } }, { provider: 'beta', model: 'b1' });
	/* The route being replaced carries the old model's effort, which the new model
	 * may not support; keeping it would fail the very next request. */
	const resolved = await listeners[1]({}, async () => ({ provider: 'alpha', model: 'a1', reasoningEffort: 'high', temperature: 0.3 }));
	assert.deepEqual(resolved, { provider: 'beta', model: 'b1', temperature: 0.3 });
	assert.equal('reasoningEffort' in resolved, false);
});

test('a missing agent is reported instead of silently recording an intent', () => {
	assert.deepEqual(selectModel({ agent: undefined, selection: { provider: 'a', model: 'b' } }), { ok: false, reason: 'session-not-live' });
});

test('a failing append leaves the running route untouched', () => {
	const agent = { session: { append: () => { throw new Error('read-only session'); } }, ctx: { on: () => () => {} } };
	const result = selectModel({ agent, selection: { provider: 'a', model: 'b' } });
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'record-failed');
});

/* ------------------------------------------------------------------ *
 * Usage
 * ------------------------------------------------------------------ */

test('session usage reads the meter projection and never double-counts reasoning', () => {
	const session = sessionStub();
	const projections = {
		stateOf: () => ({ totals: { uncachedInputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 40 }, last: { turn: 1, step: 1, buckets: {} } }),
	};
	const usage = sessionUsage({ sessionProjections: projections, session });
	assert.equal(usage.ok, true);
	assert.equal(usage.total, 190);
	assert.match(usage.text, /本会话累计 Token：190/);
	assert.match(usage.text, /输出已包含推理 Token，不重复加计/);
	assert.match(usage.text, /跨会话汇总不可用/);
});

test('usage degrades clearly when the projection, session, or samples are missing', () => {
	assert.equal(sessionUsage({}).reason, 'projection-unavailable');
	assert.equal(sessionUsage({ sessionProjections: { stateOf: () => undefined }, session: sessionStub() }).reason, 'no-usage-yet');
	assert.equal(sessionUsage({ sessionProjections: { stateOf: () => { throw new Error('x'); } }, session: sessionStub() }).reason, 'projection-unavailable');
});

test('counts are formatted for chat, including CJK magnitudes', () => {
	assert.equal(formatCount(0), '0');
	assert.equal(formatCount(9999), '9,999');
	assert.equal(formatCount(12345), '1.23万');
	assert.equal(formatCount(123456789), '1.23亿');
});

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

test('search asks for visible conversation text and maps hits', async () => {
	const calls = [];
	const sessionQuery = {
		searchSessions: async (request) => {
			calls.push(request);
			return {
				items: [
					{ header: { id: 'session-abcdef12', cwd: 'C:\\w' }, bestMatch: { sessionId: 'session-abcdef12', type: 'user/message', snippet: '关键词 出现在这里' } },
					{ header: { id: 'session-other' }, bestMatch: { sessionId: 'different-session', type: 'user/message', snippet: 'must be dropped' } },
				],
				nextCursor: 'cursor-1',
			};
		},
	};
	const result = await searchHistory({ sessionQuery, query: '  关键词  ' });
	assert.equal(result.ok, true);
	assert.equal(calls[0].query, '关键词');
	assert.equal(calls[0].limit, 10);
	assert.deepEqual(calls[0].eventFilters, [
		{ kind: 'type', values: ['user/message', 'assistant/message'] },
		{ kind: 'surface', values: ['current'] },
	]);
	assert.equal(result.items.length, 1, 'a hit whose bestMatch names another session is dropped');
	assert.equal(result.items[0].shortId, 'abcdef12');
	assert.equal(result.items[0].cwd, 'C:\\w');
	assert.equal(result.nextCursor, 'cursor-1');
});

test('a continuation cursor is passed through and never invented', async () => {
	const calls = [];
	const sessionQuery = { searchSessions: async (request) => { calls.push(request); return { items: [] }; } };
	const first = await searchHistory({ sessionQuery, query: 'x' });
	assert.equal('cursor' in calls[0], false);
	assert.equal(first.nextCursor, '');
	await searchHistory({ sessionQuery, query: 'x', cursor: 'c9' });
	assert.equal(calls[1].cursor, 'c9');
});

test('an empty query and a missing service are refused with distinct reasons', async () => {
	assert.equal((await searchHistory({ sessionQuery: {}, query: '   ' })).reason, 'query-missing');
	assert.equal((await searchHistory({ query: 'x' })).reason, 'search-unavailable');
});

test('search error codes are translated instead of surfaced raw', async () => {
	const stale = { searchSessions: async () => { const error = new Error('stale'); error.code = 'SESSION_QUERY_STALE_CURSOR'; throw error; } };
	assert.equal((await searchHistory({ sessionQuery: stale, query: 'x' })).reason, 'stale-cursor');
	const invalid = { searchSessions: async () => { const error = new Error('bad limit'); error.code = 'SESSION_QUERY_INVALID_LIMIT'; throw error; } };
	assert.equal((await searchHistory({ sessionQuery: invalid, query: 'x' })).reason, 'invalid-limit');
	const broken = { searchSessions: async () => { throw new Error('disk gone'); } };
	const failed = await searchHistory({ sessionQuery: broken, query: 'x' });
	assert.equal(failed.reason, 'search-failed');
	assert.match(failed.detail, /disk gone/);
});

test('the page size is bounded and snippets are truncated on code points', async () => {
	const calls = [];
	const sessionQuery = { searchSessions: async (request) => { calls.push(request); return { items: [] }; } };
	await searchHistory({ sessionQuery, query: 'x', limit: 999 });
	assert.equal(calls[0].limit, 20);
	const emoji = '😀'.repeat(300);
	const truncated = truncate(emoji, 10);
	assert.equal([...truncated].length, 11, 'ten code points plus the ellipsis');
	assert.equal(truncated.endsWith('…'), true);
	assert.equal(truncate('short', 10), 'short');
});
