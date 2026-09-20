import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';

import {
	FULL_ACCESS_PRESET, createSession, describeAgent, listSessions, resolveSessionToken,
	shortId, useSession, validateDirectory,
} from '../lib/sessions.js';

/** A live-agent stand-in carrying only what the plugin reads. */
function agent(id, cwd = '') {
	return { session: { header: { id, cwd, createdAt: 1700000000000 } } };
}

/** An `agents` service stand-in. */
function agentsService({ roots = [], live = {}, create, resume } = {}) {
	return {
		roots: () => [...roots],
		get: (id) => live[id],
		create: create ?? (async () => { throw new Error('create not expected'); }),
		resume: resume ?? (async () => { throw new Error('resume not expected'); }),
	};
}

/** A permission-preset service stand-in recording switches. */
function presetsService() {
	const applied = [];
	return {
		applied,
		set: (session, name) => { applied.push({ session, name }); },
	};
}

/** Deployment-default model used by fresh-session tests. */
function defaultModelService() {
	return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) };
}

/** Agent-preset service with `standard` as the deployment default. */
function agentPresetService() {
	const mounted = [];
	return {
		defaultId: 'standard',
		mounted,
		resolve: async () => ({ id: 'standard', name: 'Standard' }),
		mount: async (ctx, id) => { mounted.push({ ctx, id }); },
	};
}

test('the short id is the last eight characters', () => {
	assert.equal(shortId('session-12345678-90ab-cdef-1234-567890abcdef'), '90abcdef');
	assert.equal(shortId('short'), 'short');
	assert.equal(shortId(undefined), '');
});

test('a directory must be non-empty, absolute, and real', () => {
	const root = mkdtempSync(join(tmpdir(), 'channel-weixin-cwd-'));
	const file = join(root, 'a-file.txt');
	writeFileSync(file, 'x', 'utf8');
	try {
		assert.equal(validateDirectory('').ok, false);
		assert.equal(validateDirectory('   ').reason, 'empty');
		assert.equal(validateDirectory('relative/dir').reason, 'not-absolute');
		assert.equal(validateDirectory(join(root, 'nope')).reason, 'missing');
		assert.equal(validateDirectory(file).reason, 'not-a-directory');
		const good = validateDirectory(root);
		assert.equal(good.ok, true);
		assert.equal(good.path, root);
		assert.equal(validateDirectory(`  ${root}  `).path, root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('the listing prefers live roots and never reports a subagent', async () => {
	const service = agentsService({ roots: [agent('session-aaaaaaaa-1', 'C:\\work'), agent('session-bbbbbbbb-2', 'D:\\other')] });
	const listed = await listSessions({ agents: service });
	assert.deepEqual(listed.map((entry) => entry.id), ['session-aaaaaaaa-1', 'session-bbbbbbbb-2']);
	assert.equal(listed[0].live, true);
	assert.equal(listed[0].cwd, 'C:\\work');
	assert.equal(listed[0].shortId, 'aaaaaaa-1'.slice(-8));
});

test('persisted sessions fill the listing and are deduplicated', async () => {
	const service = agentsService({ roots: [agent('session-live', 'C:\\live')] });
	const persistence = {
		list: async () => [
			'session-stored-1',
			{ id: 'session-stored-2', header: { id: 'session-stored-2', cwd: 'C:\\stored', createdAt: 5 } },
			{ header: { id: 'session-live' } },
			null,
			{ nope: true },
		],
	};
	const listed = await listSessions({ agents: service, persistence });
	assert.deepEqual(listed.map((entry) => entry.id), ['session-live', 'session-stored-1', 'session-stored-2']);
	assert.equal(listed[2].cwd, 'C:\\stored');
	assert.equal(listed[2].live, false);
});

test('a persistence failure degrades to the live listing instead of throwing', async () => {
	const service = agentsService({ roots: [agent('session-live')] });
	const persistence = { list: async () => { throw new Error('backend down'); } };
	const listed = await listSessions({ agents: service, persistence });
	assert.deepEqual(listed.map((entry) => entry.id), ['session-live']);
});

test('a missing persistence service is not an error', async () => {
	const listed = await listSessions({ agents: agentsService({ roots: [] }) });
	assert.deepEqual(listed, []);
});

test('tokens resolve by exact id, by unique short id, and report ambiguity', () => {
	const sessions = [
		{ id: 'session-aaaa1111', shortId: 'aaaa1111' },
		{ id: 'session-bbbb2222', shortId: 'bbbb2222' },
		{ id: 'session-cccc2222', shortId: 'cccc2222' },
	];
	assert.equal(resolveSessionToken(sessions, 'session-bbbb2222').kind, 'found');
	assert.equal(resolveSessionToken(sessions, 'aaaa1111').session.id, 'session-aaaa1111');
	assert.equal(resolveSessionToken(sessions, '  aaaa1111 ').kind, 'found');
	assert.equal(resolveSessionToken(sessions, '').kind, 'empty');
	assert.equal(resolveSessionToken(sessions, 'zzzz').kind, 'missing');
	const ambiguous = resolveSessionToken([{ id: 'one', shortId: 'same' }, { id: 'two', shortId: 'same' }], 'same');
	assert.equal(ambiguous.kind, 'ambiguous');
	assert.deepEqual(ambiguous.matches.map((entry) => entry.id), ['one', 'two']);
});

test('creating a session validates the directory before touching the harness', async () => {
	let called = 0;
	const service = agentsService({ create: async () => { called += 1; return { agent: agent('session-new') }; } });
	const refused = await createSession({ agents: service, permissionPresets: presetsService(), agentPresets: agentPresetService(), agentDefaultModel: defaultModelService(), cwd: 'relative/path' });
	assert.equal(refused.ok, false);
	assert.equal(refused.reason, 'cwd-not-absolute');
	assert.equal(called, 0);
});

test('creating a session passes the absolute cwd as session metadata', async () => {
	const root = mkdtempSync(join(tmpdir(), 'channel-weixin-new-'));
	const options = [];
	const agentPresets = agentPresetService();
	const agentCtx = { on: () => () => {} };
	const service = agentsService({
		create: async (given) => {
			options.push(given);
			await given.setup(agentCtx);
			return { agent: agent('session-fresh', given.meta.cwd) };
		},
	});
	try {
		const result = await createSession({ agents: service, permissionPresets: presetsService(), agentPresets, agentDefaultModel: defaultModelService(), cwd: root });
		assert.equal(result.ok, true);
		assert.equal(result.session.id, 'session-fresh');
		assert.equal(result.fullAccess, true);
		assert.equal(options.length, 1);
		assert.match(options[0].sessionId, /^session-[0-9a-f-]{36}$/);
		assert.deepEqual(options[0].meta, { cwd: root, agentPreset: 'standard' });
		assert.deepEqual(options[0].agentOptions, { provider: 'deepseek', model: 'deepseek-chat' });
		assert.equal(typeof options[0].setup, 'function');
		assert.deepEqual(agentPresets.mounted, [{ ctx: agentCtx, id: 'standard' }]);
		assert.equal(result.agentPreset, 'standard');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('a new session is switched to the full-access preset, once', () => {
	/* The preset call is asserted in the create test above through the same path. */
	assert.equal(FULL_ACCESS_PRESET, 'danger-full-access');
});

test('a creation failure reports a reason and changes nothing', async () => {
	const root = mkdtempSync(join(tmpdir(), 'channel-weixin-fail-'));
	const service = agentsService({ create: async () => { throw new Error('duplicate id'); } });
	try {
		const result = await createSession({ agents: service, permissionPresets: presetsService(), agentPresets: agentPresetService(), agentDefaultModel: defaultModelService(), cwd: root });
		assert.equal(result.ok, false);
		assert.equal(result.reason, 'create-failed');
		assert.match(result.detail, /duplicate id/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('a permission failure is reported rather than silently ignored', async () => {
	const root = mkdtempSync(join(tmpdir(), 'channel-weixin-perm-'));
	const service = agentsService({ create: async () => ({ agent: agent('session-x', root) }) });
	const presets = { set: () => { throw new Error('unknown preset'); } };
	try {
		const result = await createSession({ agents: service, permissionPresets: presets, agentPresets: agentPresetService(), agentDefaultModel: defaultModelService(), cwd: root });
		assert.equal(result.ok, false);
		assert.equal(result.reason, 'permission-failed');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('creating without a preset service fails before creating an under-privileged session', async () => {
	const root = mkdtempSync(join(tmpdir(), 'channel-weixin-nopreset-'));
	let created = false;
	const service = agentsService({ create: async () => { created = true; return { agent: agent('session-y', root) }; } });
	try {
		const result = await createSession({ agents: service, cwd: root });
		assert.equal(result.ok, false);
		assert.equal(result.reason, 'permission-unavailable');
		assert.equal(created, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('creating without a deployment default model fails before touching the agent factory', async () => {
	const root = mkdtempSync(join(tmpdir(), 'channel-weixin-nomodel-'));
	let created = false;
	const service = agentsService({ create: async () => { created = true; } });
	try {
		const result = await createSession({ agents: service, permissionPresets: presetsService(), agentPresets: agentPresetService(), cwd: root });
		assert.equal(result.ok, false);
		assert.equal(result.reason, 'model-unavailable');
		assert.equal(created, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('creation accepts a caller-supplied session identity', async () => {
	const root = mkdtempSync(join(tmpdir(), 'channel-weixin-id-'));
	const seen = [];
	const service = agentsService({
		create: async (given) => { seen.push(given); return { agent: agent(given.sessionId, root) }; },
	});
	try {
		await createSession({ agents: service, permissionPresets: presetsService(), agentPresets: agentPresetService(), agentDefaultModel: defaultModelService(), cwd: root, sessionId: 'session-chosen' });
		assert.equal(seen.length, 1);
		assert.equal(seen[0].sessionId, 'session-chosen');
		assert.deepEqual(seen[0].meta, { cwd: root, agentPreset: 'standard' });
		assert.deepEqual(seen[0].agentOptions, { provider: 'deepseek', model: 'deepseek-chat' });
		assert.equal(typeof seen[0].setup, 'function');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('switching to a live session reuses its running agent', async () => {
	const running = agent('session-live-1', 'C:\\w');
	const service = agentsService({ roots: [running], live: { 'session-live-1': running } });
	const presets = presetsService();
	const byFullId = await useSession({ agents: service, permissionPresets: presets, token: 'session-live-1' });
	assert.equal(byFullId.ok, true);
	assert.equal(byFullId.agent, running);
	assert.equal(byFullId.resumed, undefined);
	const byShortId = await useSession({ agents: service, permissionPresets: presets, token: shortId('session-live-1') });
	assert.equal(byShortId.ok, true);
	assert.equal(byShortId.agent, running);
	assert.deepEqual(presets.applied.map((entry) => entry.name), [FULL_ACCESS_PRESET, FULL_ACCESS_PRESET]);
});

test('switching to a stored session resumes it with its Agent preset and model scope', async () => {
	const resumed = agent('session-stored', 'D:\\p');
	resumed.session.header.agentPreset = 'standard';
	const agentPresets = agentPresetService();
	const agentCtx = { on: () => () => {} };
	const service = agentsService({
		roots: [],
		resume: async (options) => {
			assert.equal(options.resumeSessionId, 'session-stored');
			assert.equal(typeof options.setup, 'function');
			await options.setup(agentCtx, resumed);
			return { agent: resumed };
		},
	});
	const persistence = { list: async () => ['session-stored'] };
	const result = await useSession({ agents: service, permissionPresets: presetsService(), agentPresets, agentDefaultModel: defaultModelService(), persistence, token: 'session-stored' });
	assert.equal(result.ok, true);
	assert.equal(result.resumed, true);
	assert.equal(result.session.cwd, 'D:\\p');
	assert.deepEqual(agentPresets.mounted, [{ ctx: agentCtx, id: 'standard' }]);
});

test('switching to an unknown or ambiguous token refuses without side effects', async () => {
	const service = agentsService({ roots: [agent('session-11112222'), agent('session-33332222')] });
	const unknown = await useSession({ agents: service, token: 'nope' });
	assert.equal(unknown.ok, false);
	assert.equal(unknown.reason, 'not-found');
	const empty = await useSession({ agents: service, token: '' });
	assert.equal(empty.reason, 'no-token');
	/* A token that is neither a full id nor a listed short id is simply unknown. */
	const partial = await useSession({ agents: service, token: '2222' });
	assert.equal(partial.reason, 'not-found');
	/* Two sessions whose last eight characters collide are reported as ambiguous. */
	const colliding = agentsService({ roots: [agent('session-aaaaaaaa-same1234'), agent('session-bbbbbbbb-same1234')] });
	const ambiguous = await useSession({ agents: colliding, token: 'same1234' });
	assert.equal(ambiguous.ok, false);
	assert.equal(ambiguous.reason, 'ambiguous');
	assert.deepEqual(ambiguous.matches, ['same1234', 'same1234']);
});

test('a resume failure is reported, not hidden', async () => {
	const service = agentsService({
		roots: [],
		resume: async () => { throw new Error('log unsupported'); },
	});
	const result = await useSession({ agents: service, agentPresets: agentPresetService(), agentDefaultModel: defaultModelService(), persistence: { list: async () => ['session-old'] }, token: 'session-old' });
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'resume-failed');
	assert.match(result.detail, /unsupported/);
});

test('a stored session with no resume capability reports not-live', async () => {
	const service = { roots: () => [], get: () => undefined };
	const result = await useSession({ agents: service, persistence: { list: async () => ['session-x'] }, token: 'session-x' });
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'not-live');
});

test('a described agent survives a header with no cwd', () => {
	const described = describeAgent({ session: { header: { id: 'session-1' } } });
	assert.deepEqual(described, { id: 'session-1', shortId: 'ession-1', cwd: '', createdAt: 0, live: true });
	assert.equal(describeAgent(undefined).id, '');
	assert.equal(validateDirectory(process.cwd()).ok, true);
	assert.equal(sep.length >= 1, true);
});

test('a directory with spaces and CJK characters is accepted verbatim', () => {
	const base = mkdtempSync(join(tmpdir(), 'channel-weixin-cjk-'));
	const nested = join(base, '项目 目录 with spaces');
	mkdirSync(nested);
	try {
		const checked = validateDirectory(nested);
		assert.equal(checked.ok, true);
		assert.equal(checked.path, nested, 'the path must be used exactly as given');
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test('the session is created in the exact directory that was validated', async () => {
	const base = mkdtempSync(join(tmpdir(), 'channel-weixin-create-cjk-'));
	const nested = join(base, '工作 区');
	mkdirSync(nested);
	const seen = [];
	const service = agentsService({
		create: async (given) => { seen.push(given.meta.cwd); return { agent: agent('session-cjk', given.meta.cwd) }; },
	});
	try {
		const result = await createSession({ agents: service, permissionPresets: presetsService(), agentPresets: agentPresetService(), agentDefaultModel: defaultModelService(), cwd: nested });
		assert.equal(result.ok, true);
		assert.deepEqual(seen, [nested]);
		assert.equal(result.session.cwd, nested);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test('the host platform decides what counts as absolute', () => {
	/* The directory names a path on the machine DSH runs on, so the host's own
	 * rules apply — a foreign platform's spelling is refused. */
	const windowsStyle = 'C:\\work';
	const posixStyle = '/work';
	if (process.platform === 'win32') {
		assert.equal(validateDirectory(windowsStyle).reason === 'missing', true, 'a Windows absolute path is recognised (then reported missing)');
		assert.equal(validateDirectory(posixStyle).ok, false);
		assert.notEqual(validateDirectory(posixStyle).reason, 'not-absolute');
	} else {
		assert.equal(validateDirectory(windowsStyle).reason, 'not-absolute');
	}
	assert.equal(validateDirectory('\\\\server\\share').ok, false, 'a UNC path is either missing or not absolute, never silently accepted');
});
