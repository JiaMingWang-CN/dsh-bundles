/**
 * DSH session integration: list, create, switch, and map the permission preset.
 *
 * Everything here takes its DSH services (and, for directory checks, `stat`) as
 * arguments, so the whole module is unit-testable without a harness. The rules
 * it enforces come from the plan:
 *
 * - Only top-level agents are switchable (`agents.roots()`); subagent children
 *   never appear in the list and are never adopted.
 * - A directory must already exist and be absolute before any session is
 *   created; validation failure leaves the caller's binding untouched.
 * - A new session is bound to the `danger-full-access` preset, which is
 *   per-session: other DSH sessions keep their own settings.
 * - Switching reuses a live agent when one exists, and otherwise resumes the
 *   persisted session; it never starts a second writer for a live session.
 */

import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { installModelOverride } from './model.js';

/** The preset that gives WeChat-submitted work full file access without prompts. */
const FULL_ACCESS_PRESET = 'danger-full-access';

/** Maximum sessions returned to a chat listing, so one reply stays readable. */
const LIST_LIMIT = 20;

/**
 * Short, unambiguous-enough session label used in chat replies.
 * @param id - session identity.
 * @returns the last eight characters, or the whole id when it is short.
 */
function shortId(id) {
	const value = typeof id === 'string' ? id : '';
	return value.length <= 8 ? value : value.slice(-8);
}

/**
 * Validate a working directory before it is used.
 *
 * Absolute-path and existence checks happen here rather than in the harness, so
 * a typo produces a clear refusal instead of a session created somewhere else.
 * @param path - the caller-supplied directory.
 * @param stat - injectable `statSync` for tests.
 * @returns `{ ok: true, path }` or `{ ok: false, reason }`.
 */
function validateDirectory(path, stat = statSync) {
	if (typeof path !== 'string' || path.trim() === '') return { ok: false, reason: 'empty' };
	const candidate = path.trim();
	if (!isAbsolute(candidate)) return { ok: false, reason: 'not-absolute' };
	let info;
	try {
		info = stat(candidate);
	} catch {
		return { ok: false, reason: 'missing' };
	}
	if (info === undefined || typeof info.isDirectory !== 'function' || !info.isDirectory()) return { ok: false, reason: 'not-a-directory' };
	return { ok: true, path: candidate };
}

/**
 * One session's chat-visible description.
 * @param agent - a live agent.
 * @returns id, short id, cwd, and creation time.
 */
function describeAgent(agent) {
	const header = agent?.session?.header ?? {};
	const id = typeof header.id === 'string' && header.id !== '' ? header.id : (typeof agent?.id === 'string' ? agent.id : '');
	return {
		id,
		shortId: shortId(id),
		cwd: typeof header.cwd === 'string' ? header.cwd : '',
		createdAt: Number.isFinite(header.createdAt) ? header.createdAt : 0,
		live: true,
	};
}

/**
 * Normalize one persisted-session listing entry.
 *
 * `sessionPersistence.list()` is a backend contract whose entries this plugin
 * does not own, so both plausible shapes (a bare id, or a record carrying
 * `id`/`header`) are accepted and anything else is ignored rather than guessed.
 * @param entry - one listing entry.
 * @returns a session description, or undefined when unusable.
 */
function normalizeStored(entry) {
	if (typeof entry === 'string') return { id: entry, shortId: shortId(entry), cwd: '', createdAt: 0, live: false };
	if (entry === null || typeof entry !== 'object') return undefined;
	const header = entry.header ?? entry;
	const id = typeof header.id === 'string' ? header.id : (typeof entry.id === 'string' ? entry.id : '');
	if (id === '') return undefined;
	return {
		id,
		shortId: shortId(id),
		cwd: typeof header.cwd === 'string' ? header.cwd : '',
		createdAt: Number.isFinite(header.createdAt) ? header.createdAt : 0,
		live: false,
	};
}

/**
 * Every switchable session: live top-level agents first, then persisted
 * sessions that are not live, deduplicated by id.
 * @param options - the `agents` service and an optional persistence service.
 * @returns a bounded, ordered session list.
 */
async function listSessions({ agents, persistence }) {
	const live = [];
	if (agents !== undefined && typeof agents.roots === 'function') {
		for (const agent of agents.roots()) {
			const described = describeAgent(agent);
			if (described.id !== '') live.push(described);
		}
	}
	const seen = new Set(live.map((session) => session.id));
	const stored = [];
	if (persistence !== undefined && typeof persistence.list === 'function') {
		let entries;
		try {
			entries = await persistence.list();
		} catch {
			entries = [];
		}
		for (const entry of Array.isArray(entries) ? entries : []) {
			const described = normalizeStored(entry);
			if (described === undefined || seen.has(described.id)) continue;
			seen.add(described.id);
			stored.push(described);
		}
	}
	return [...live, ...stored].slice(0, LIST_LIMIT);
}

/**
 * Resolve a user-typed session token against the listing.
 * @param sessions - the current listing.
 * @param token - exact id or short id typed by the user.
 * @returns `{ kind: 'found' | 'empty' | 'missing' | 'ambiguous', session?, matches? }`.
 */
function resolveSessionToken(sessions, token) {
	const wanted = typeof token === 'string' ? token.trim() : '';
	if (wanted === '') return { kind: 'empty' };
	const exact = sessions.find((session) => session.id === wanted);
	if (exact !== undefined) return { kind: 'found', session: exact };
	const matches = sessions.filter((session) => session.shortId === wanted);
	if (matches.length === 1) return { kind: 'found', session: matches[0] };
	if (matches.length > 1) return { kind: 'ambiguous', matches };
	return { kind: 'missing' };
}

/**
 * Create a session in an existing directory with full file access.
 *
 * The directory is validated first and a failed creation leaves nothing behind:
 * `agents.create` owns its own rollback, and the permission preset is only
 * applied once the agent exists.
 * @param options - services, target directory, optional identity, and injectable stat.
 * @returns `{ ok: true, session }` or `{ ok: false, reason }`.
 */
async function createSession({ agents, permissionPresets, agentPresets, agentDefaultModel, cwd, sessionId, stat }) {
	const checked = validateDirectory(cwd, stat ?? statSync);
	if (!checked.ok) return { ok: false, reason: 'cwd-' + checked.reason };
	if (permissionPresets === undefined || typeof permissionPresets.set !== 'function') {
		return { ok: false, reason: 'permission-unavailable' };
	}
	if (agentPresets === undefined || typeof agentPresets.resolve !== 'function' || typeof agentPresets.mount !== 'function') {
		return { ok: false, reason: 'agent-preset-unavailable' };
	}
	let selection;
	let agentPreset;
	try {
		selection = agentDefaultModel?.currentSelection?.();
		agentPreset = await agentPresets.resolve();
	} catch (error) {
		return { ok: false, reason: 'composition-unavailable', detail: String(error?.message ?? error) };
	}
	if (typeof selection?.provider !== 'string' || selection.provider === '' || typeof selection?.model !== 'string' || selection.model === '') {
		return { ok: false, reason: 'model-unavailable', detail: 'deployment default model is missing' };
	}
	if (typeof agentPreset?.id !== 'string' || agentPreset.id === '') {
		return { ok: false, reason: 'agent-preset-unavailable' };
	}
	/* Agent and Session share one caller-supplied identity in DSH 0.1.5. Omitting
	 * it lets the session store mint an id while the agent id remains undefined. */
	const identity = sessionId ?? `session-${randomUUID()}`;
	let published;
	try {
		published = await agents.create({
			sessionId: identity,
			meta: { cwd: checked.path, agentPreset: agentPreset.id },
			agentOptions: {
				provider: selection.provider,
				model: selection.model,
				...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
			},
			/* DSH assembles the system prompt before the request waterfall. Install the
			 * selection during the unpublished setup window so {{model}}/{{provider}}
			 * exist on the very first turn. */
			setup: async (agentCtx) => {
				installModelOverride(agentCtx, selection);
				await agentPresets.mount(agentCtx, agentPreset.id);
			},
		});
	} catch (error) {
		return { ok: false, reason: 'create-failed', detail: String(error?.message ?? error) };
	}
	const agent = published?.agent ?? published;
	if (agent === undefined || agent.session === undefined) return { ok: false, reason: 'create-returned-nothing' };
	try {
		permissionPresets.set(agent.session, FULL_ACCESS_PRESET);
	} catch (error) {
		return { ok: false, reason: 'permission-failed', detail: String(error?.message ?? error), session: describeAgent(agent) };
	}
	return { ok: true, session: describeAgent(agent), fullAccess: true, agentPreset: agentPreset.id };
}

/**
 * Adopt one existing session by token: reuse its live agent, or resume it.
 * @param options - services, the typed token, and an optional persistence service.
 * @returns `{ ok: true, session, agent }` or `{ ok: false, reason, matches? }`.
 */
async function useSession({ agents, permissionPresets, agentPresets, agentDefaultModel, persistence, token }) {
	const sessions = await listSessions({ agents, persistence });
	const resolved = resolveSessionToken(sessions, token);
	if (resolved.kind === 'empty') return { ok: false, reason: 'no-token' };
	if (resolved.kind === 'missing') return { ok: false, reason: 'not-found' };
	if (resolved.kind === 'ambiguous') return { ok: false, reason: 'ambiguous', matches: resolved.matches.map((session) => session.shortId) };
	let agent = typeof agents.get === 'function' ? agents.get(resolved.session.id) : undefined;
	let resumed = false;
	if (agent === undefined) {
		if (typeof agents.resume !== 'function') return { ok: false, reason: 'not-live' };
		if (agentPresets === undefined || typeof agentPresets.mount !== 'function') return { ok: false, reason: 'agent-preset-unavailable' };
		let fallbackSelection;
		try {
			fallbackSelection = agentDefaultModel?.currentSelection?.();
		} catch (error) {
			return { ok: false, reason: 'model-unavailable', detail: String(error?.message ?? error) };
		}
		let published;
		try {
			published = await agents.resume({
				resumeSessionId: resolved.session.id,
				setup: async (agentCtx, resumedAgent) => {
					const recorded = resumedAgent.session.requestHeader?.()?.config;
					const selection = typeof recorded?.provider === 'string' && typeof recorded?.model === 'string' ? recorded : fallbackSelection;
					if (typeof selection?.provider !== 'string' || typeof selection?.model !== 'string') throw new Error('session has no model selection');
					installModelOverride(agentCtx, selection);
					await agentPresets.mount(agentCtx, resumedAgent.session.header?.agentPreset);
				},
			});
		} catch (error) {
			return { ok: false, reason: 'resume-failed', detail: String(error?.message ?? error) };
		}
		agent = published?.agent ?? published;
		if (agent === undefined) return { ok: false, reason: 'resume-returned-nothing' };
		resumed = true;
	}
	if (permissionPresets === undefined || typeof permissionPresets.set !== 'function') {
		return { ok: false, reason: 'permission-unavailable' };
	}
	try {
		permissionPresets.set(agent.session, FULL_ACCESS_PRESET);
	} catch (error) {
		return { ok: false, reason: 'permission-failed', detail: String(error?.message ?? error) };
	}
	return { ok: true, session: describeAgent(agent), agent, fullAccess: true, ...(resumed ? { resumed: true } : {}) };
}

/** Pure helpers exercised by the unit tests. */
const testing = {
	FULL_ACCESS_PRESET, LIST_LIMIT, shortId, validateDirectory, describeAgent,
	normalizeStored, resolveSessionToken,
};

export {
	FULL_ACCESS_PRESET, LIST_LIMIT, createSession, describeAgent, listSessions,
	normalizeStored, resolveSessionToken, shortId, testing, useSession, validateDirectory,
};
