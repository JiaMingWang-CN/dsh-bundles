import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { testing } from '../lib/index.js';

function message(turn, step, usage, provider = 'provider', model = 'model') {
	return {
		type: 'assistant/message',
		data: {
			turn,
			step,
			usage,
			message: { source: { provider, model } },
		},
	};
}

const firstUsage = {
	inputTokens: 10,
	cacheReadTokens: 20,
	cacheWriteTokens: 30,
	outputTokens: 40,
	reasoningTokens: 5,
};
const finalUsage = {
	inputTokens: 1,
	cacheReadTokens: 2,
	cacheWriteTokens: 3,
	outputTokens: 4,
	reasoningTokens: 1,
};

test('a repeated settlement replaces every token bucket', () => {
	const groups = new Map(testing.foldSession([
		message(1, 2, firstUsage),
		message(1, 2, finalUsage),
	]));

	assert.deepEqual(groups.get('provider\0model'), {
		input: 1,
		cacheRead: 2,
		cacheWrite: 3,
		output: 4,
		reasoning: 1,
		requests: 1,
		sessions: 0,
	});
});

test('a retry retains consumed tokens but remains one logical request', () => {
	const groups = new Map(testing.foldSession([
		message(1, 2, firstUsage),
		{ type: 'llm/retry-started', data: { turn: 1, step: 2 } },
		message(1, 2, finalUsage),
	]));

	assert.equal(groups.get('provider\0model').input, 11);
	assert.equal(groups.get('provider\0model').output, 44);
	assert.equal(groups.get('provider\0model').requests, 1);
});

test('replacement through another route removes the empty old group', () => {
	const groups = new Map(testing.foldSession([
		message(1, 2, firstUsage, 'old-provider', 'old-model'),
		message(1, 2, finalUsage, 'new-provider', 'new-model'),
	]));

	assert.equal(groups.has('old-provider\0old-model'), false);
	assert.equal(groups.get('new-provider\0new-model').input, 1);
});

test('report exposes the real token composition for the overview', () => {
	const payload = testing.report({
		byRoute: new Map(),
		byModel: new Map(),
		sessions: [],
		totals: { input: 10, cacheRead: 20, cacheWrite: 0, output: 30, reasoning: 5, requests: 2, sessions: 1 },
		listed: 1,
		skipped: 0,
		excluded: 0,
		decoded: 1,
	}, 0);

	assert.deepEqual(payload.totals.composition.map(({ id, share }) => ({ id, share })), [
		{ id: 'input', share: 16.7 },
		{ id: 'cacheRead', share: 33.3 },
		{ id: 'cacheWrite', share: 0 },
		{ id: 'output', share: 50 },
	]);
});

test('session root honors DSH_HOME and retains the default fallback', () => {
	assert.equal(testing.sessionsRoot({ DSH_HOME: join('custom', 'dsh') }, 'home'), join('custom', 'dsh', 'sessions'));
	assert.equal(testing.sessionsRoot({}, 'home'), join('home', '.dsh', 'sessions'));
});

test('file discovery includes only persisted session logs', () => {
	const root = mkdtempSync(join(tmpdir(), 'dsh-usage-stats-'));
	try {
		const nested = join(root, 'session-1');
		mkdirSync(nested);
		const log = join(nested, 'session.v3.jsonl.zstd');
		writeFileSync(log, '');
		writeFileSync(join(nested, 'metadata.json'), '{}');
		assert.deepEqual(testing.walkFiles(root), [log]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
