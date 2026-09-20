/**
 * Plugin-owned credential storage.
 *
 * The WeChat bot token is a bearer credential for the user's own account, so it
 * lives in its own file under the harness storage root (`$DSH_HOME/storages/`),
 * never in general settings and never in a browser-facing payload.
 *
 * Written with the same discipline as the harness's own atomic writer: an
 * exclusive temporary file carrying the final permission bits, then a rename
 * over the target, so a reader never observes a half-written credential and a
 * crash cannot leave a truncated file in place.
 *
 * Node built-ins only: a third-party bundle resolves no dependency from the
 * harness installation, so a storage library is not available here.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { trustedBaseUrl } from './weixin.js';

/** Directory (inside the harness storage root) owned by this plugin. */
const STORE_DIR = 'channel-weixin';

/** Credential file name inside {@link STORE_DIR}. */
const ACCOUNT_FILE = 'account.json';

/** Per-peer session bindings file inside {@link STORE_DIR}. */
const BINDINGS_FILE = 'bindings.json';

/** Inbound poll cursor plus the duplicate-suppression window. */
const CHANNEL_STATE_FILE = 'channel-state.json';

/** Channel-state document version. */
const CHANNEL_STATE_VERSION = 1;

/** Scheduled tasks file inside {@link STORE_DIR}. */
const SCHEDULES_FILE = 'schedules.json';

/** Schedules document version. */
const SCHEDULES_VERSION = 1;

/** Bindings document version, so a later shape change can migrate rather than guess. */
const BINDINGS_VERSION = 1;

/** Private file mode: owner read/write only (POSIX; on Windows this is advisory). */
const FILE_MODE = 0o600;

/** Owner-only directory mode. */
const DIR_MODE = 0o700;

/**
 * This plugin's storage root, honoring an explicit `DSH_HOME` exactly as the
 * harness does.
 * @param env - environment record.
 * @param home - the user's home directory.
 * @returns absolute path of the plugin's storage directory.
 */
function storageRoot(env = process.env, home = homedir()) {
	return join(env.DSH_HOME || join(home, '.dsh'), 'storages', STORE_DIR);
}

/** Absolute path of the credential file. */
function accountPath(root) {
	return join(root, ACCOUNT_FILE);
}

/**
 * Validate one stored account record.
 *
 * A record that does not match is treated as absent rather than partially
 * trusted: a truncated or hand-edited file must not produce a half-configured
 * connection.
 * @param value - parsed JSON value.
 * @returns the account, or undefined when the record is unusable.
 */
function parseAccount(value) {
	if (value === null || typeof value !== 'object') return undefined;
	const { botToken, baseUrl, botId, userId, savedAt } = value;
	if (typeof botToken !== 'string' || botToken === '') return undefined;
	const trustedBase = trustedBaseUrl(baseUrl);
	if (trustedBase === undefined) return undefined;
	/* The scanned user's identity is the authorization boundary. Without it the
	 * receiver cannot distinguish the account owner from another contact. */
	if (typeof userId !== 'string' || userId === '') return undefined;
	return {
		botToken,
		baseUrl: trustedBase,
		botId: typeof botId === 'string' ? botId : '',
		userId,
		savedAt: Number.isFinite(savedAt) ? savedAt : 0,
	};
}

/**
 * Read the stored credential.
 * @param root - plugin storage root.
 * @returns the account, or null when absent or unusable.
 */
function readAccount(root) {
	let raw;
	try {
		raw = readFileSync(accountPath(root), 'utf8');
	} catch {
		return null;
	}
	try {
		return parseAccount(JSON.parse(raw)) ?? null;
	} catch {
		return null;
	}
}

/**
 * Write the credential atomically with private permissions.
 * @param root - plugin storage root.
 * @param account - {@link parseAccount}-shaped record; `savedAt` is stamped when absent.
 * @returns the stored account.
 */
function writeAccount(root, account) {
	const record = parseAccount({
		botToken: account?.botToken,
		baseUrl: account?.baseUrl,
		botId: account?.botId ?? '',
		userId: account?.userId ?? '',
		savedAt: Number.isFinite(account?.savedAt) ? account.savedAt : Date.now(),
	});
	if (record === undefined) throw new TypeError('refusing to store an invalid WeChat credential');
	mkdirSync(root, { recursive: true, mode: DIR_MODE });
	const target = accountPath(root);
	const temp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
	writeFileSync(temp, JSON.stringify(record, void 0, 2) + '\n', { mode: FILE_MODE });
	try {
		renameSync(temp, target);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
	try {
		chmodSync(target, FILE_MODE);
	} catch {
		/* Windows: POSIX mode bits are advisory; the ACL is what protects the file. */
	}
	return record;
}

/**
 * Remove the stored credential (logout).
 * @param root - plugin storage root.
 * @returns whether a file was removed.
 */
function clearAccount(root) {
	try {
		rmSync(accountPath(root), { force: true });
		return true;
	} catch {
		return false;
	}
}

/** Absolute path of the bindings file. */
function bindingsPath(root) {
	return join(root, BINDINGS_FILE);
}

/** One validated binding record, or undefined when unusable. */
function parseBinding(value) {
	if (value === null || typeof value !== 'object') return undefined;
	const { sessionId, cwd, model, updatedAt } = value;
	if (typeof sessionId !== 'string' || sessionId === '') return undefined;
	return {
		sessionId,
		cwd: typeof cwd === 'string' ? cwd : '',
		model: typeof model === 'string' ? model : '',
		updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
	};
}

/**
 * Every stored peer binding.
 * @param root - plugin storage root.
 * @returns a peer-keyed record; an absent or damaged file reads as empty.
 */
function readBindings(root) {
	let raw;
	try {
		raw = readFileSync(bindingsPath(root), 'utf8');
	} catch {
		return {};
	}
	try {
		const parsed = JSON.parse(raw);
		if (parsed === null || typeof parsed !== 'object' || parsed.version !== BINDINGS_VERSION) return {};
		const peers = parsed.peers;
		if (peers === null || typeof peers !== 'object') return {};
		const result = {};
		for (const [peer, value] of Object.entries(peers)) {
			const binding = parseBinding(value);
			if (binding !== undefined) result[peer] = binding;
		}
		return result;
	} catch {
		return {};
	}
}

/**
 * Write every peer binding atomically with private permissions.
 * @param root - plugin storage root.
 * @param bindings - peer-keyed bindings.
 * @returns the written document.
 */
function writeBindings(root, bindings) {
	const peers = {};
	for (const [peer, value] of Object.entries(bindings ?? {})) {
		const binding = parseBinding(value);
		if (binding !== undefined) peers[peer] = binding;
	}
	const document = { version: BINDINGS_VERSION, peers };
	mkdirSync(root, { recursive: true, mode: DIR_MODE });
	const target = bindingsPath(root);
	const temp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
	writeFileSync(temp, JSON.stringify(document, void 0, 2) + '\n', { mode: FILE_MODE });
	try {
		renameSync(temp, target);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
	try {
		chmodSync(target, FILE_MODE);
	} catch {
		/* Windows: POSIX mode bits are advisory; the ACL is what protects the file. */
	}
	return document;
}

/**
 * Bind one peer to one session, leaving every other peer untouched.
 * @param root - plugin storage root.
 * @param peer - the WeChat peer identity.
 * @param binding - session id plus optional cwd/model.
 * @returns the stored binding.
 */
function writeBinding(root, peer, binding) {
	const record = { ...parseBinding(binding), updatedAt: Date.now() };
	const bindings = readBindings(root);
	bindings[peer] = record;
	writeBindings(root, bindings);
	return record;
}

/**
 * Remove one peer's binding (used when a bound session disappears).
 * @param root - plugin storage root.
 * @param peer - the WeChat peer identity.
 * @returns whether a binding existed.
 */
function clearBinding(root, peer) {
	const bindings = readBindings(root);
	if (!Object.hasOwn(bindings, peer)) return false;
	delete bindings[peer];
	writeBindings(root, bindings);
	return true;
}

/** Absolute path of the channel-state file. */
function channelStatePath(root) {
	return join(root, CHANNEL_STATE_FILE);
}

/**
 * Read the inbound cursor, duplicate window, in-flight marker, and last reply
 * failure.
 *
 * These live in one document on purpose: the plan requires the handled-message
 * record and the cursor to move together, so a crash between them cannot advance
 * the cursor past a message that was never recorded. The in-flight marker is the
 * other half of that promise — it records a submission whose acceptance was
 * never confirmed, so a restart reports it instead of executing it again.
 * @param root - plugin storage root.
 * @returns the channel state; a damaged file reads as a fresh state.
 */
function readChannelState(root) {
	const empty = { cursor: '', seenIds: [], inflight: undefined, lastReplyError: '', updatedAt: 0 };
	let raw;
	try {
		raw = readFileSync(channelStatePath(root), 'utf8');
	} catch {
		return empty;
	}
	try {
		return parseChannelState(JSON.parse(raw));
	} catch {
		return empty;
	}
}

/** Validate one channel-state document, dropping anything unusable. */
function parseChannelState(parsed) {
	if (parsed === null || typeof parsed !== 'object' || parsed.version !== CHANNEL_STATE_VERSION) {
		return { cursor: '', seenIds: [], inflight: undefined, lastReplyError: '', updatedAt: 0 };
	}
	return {
		cursor: typeof parsed.cursor === 'string' ? parsed.cursor : '',
		seenIds: Array.isArray(parsed.seenIds) ? parsed.seenIds.filter((id) => typeof id === 'string' && id !== '') : [],
		inflight: parseInflight(parsed.inflight),
		lastReplyError: typeof parsed.lastReplyError === 'string' ? parsed.lastReplyError : '',
		updatedAt: Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0,
	};
}

/** One unconfirmed submission, or undefined when the record is unusable. */
function parseInflight(value) {
	if (value === null || typeof value !== 'object') return undefined;
	const { messageId, requestId, sessionId, text } = value;
	if (typeof messageId !== 'string' || messageId === '') return undefined;
	if (typeof requestId !== 'string' || requestId === '') return undefined;
	if (typeof sessionId !== 'string' || sessionId === '') return undefined;
	return {
		messageId,
		requestId,
		sessionId,
		text: typeof text === 'string' ? value.text : '',
		at: Number.isFinite(value.at) ? value.at : 0,
		state: value.state === 'unconfirmed' ? 'unconfirmed' : 'submitting',
	};
}

/**
 * Write the inbound cursor and duplicate window in one atomic replacement.
 * @param root - plugin storage root.
 * @param state - `{ cursor, seenIds }`.
 * @returns the written document.
 */
function writeChannelState(root, state) {
	const document = {
		version: CHANNEL_STATE_VERSION,
		cursor: typeof state?.cursor === 'string' ? state.cursor : '',
		seenIds: (Array.isArray(state?.seenIds) ? state.seenIds : []).filter((id) => typeof id === 'string' && id !== ''),
		inflight: parseInflight(state?.inflight),
		lastReplyError: typeof state?.lastReplyError === 'string' ? state.lastReplyError : '',
		updatedAt: Date.now(),
	};
	mkdirSync(root, { recursive: true, mode: DIR_MODE });
	const target = channelStatePath(root);
	const temp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
	writeFileSync(temp, JSON.stringify(document, void 0, 2) + '\n', { mode: FILE_MODE });
	try {
		renameSync(temp, target);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
	try {
		chmodSync(target, FILE_MODE);
	} catch {
		/* Windows: POSIX mode bits are advisory; the ACL is what protects the file. */
	}
	return document;
}

/** Absolute path of the schedules file. */
function schedulesPath(root) {
	return join(root, SCHEDULES_FILE);
}

/** One validated schedule entry, or undefined when unusable. */
function parseSchedule(value) {
	if (value === null || typeof value !== 'object') return undefined;
	const { id, peer, sessionId, text, kind } = value;
	if (typeof id !== 'string' || id === '') return undefined;
	if (typeof peer !== 'string' || peer === '') return undefined;
	if (typeof sessionId !== 'string' || sessionId === '') return undefined;
	if (typeof text !== 'string' || text === '') return undefined;
	if (kind !== 'once' && kind !== 'every') return undefined;
	const number = (candidate, fallback = 0) => (Number.isFinite(candidate) ? candidate : fallback);
	return {
		id,
		peer,
		sessionId,
		cwd: typeof value.cwd === 'string' ? value.cwd : '',
		text,
		kind,
		at: number(value.at),
		everyMs: kind === 'every' ? number(value.everyMs) : 0,
		nextAt: number(value.nextAt),
		timeZone: typeof value.timeZone === 'string' ? value.timeZone : '',
		createdAt: number(value.createdAt),
		sequence: number(value.sequence),
		runs: number(value.runs),
		missed: number(value.missed),
		lastOutcome: typeof value.lastOutcome === 'string' ? value.lastOutcome : '',
		lastRunAt: number(value.lastRunAt),
	};
}

/**
 * Read the schedules document.
 * @param root - plugin storage root.
 * @returns `{ nextId, entries }`; a damaged document reads as empty rather than guessed.
 */
function readSchedules(root) {
	const empty = { nextId: 1, entries: [] };
	let raw;
	try {
		raw = readFileSync(schedulesPath(root), 'utf8');
	} catch {
		return empty;
	}
	try {
		const parsed = JSON.parse(raw);
		if (parsed === null || typeof parsed !== 'object' || parsed.version !== SCHEDULES_VERSION) return empty;
		const entries = (Array.isArray(parsed.entries) ? parsed.entries : []).map(parseSchedule).filter((entry) => entry !== undefined);
		const nextId = Number.isSafeInteger(parsed.nextId) && parsed.nextId > 0 ? parsed.nextId : entries.length + 1;
		return { nextId: Math.max(nextId, entries.length + 1), entries };
	} catch {
		return empty;
	}
}

/**
 * Write the schedules document atomically.
 * @param root - plugin storage root.
 * @param document - `{ nextId, entries }`.
 * @returns the written document.
 */
function writeSchedules(root, document) {
	const entries = (Array.isArray(document?.entries) ? document.entries : []).map(parseSchedule).filter((entry) => entry !== undefined);
	const nextId = Number.isSafeInteger(document?.nextId) && document.nextId > 0 ? document.nextId : entries.length + 1;
	const written = { version: SCHEDULES_VERSION, nextId, entries, updatedAt: Date.now() };
	mkdirSync(root, { recursive: true, mode: DIR_MODE });
	const target = schedulesPath(root);
	const temp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
	writeFileSync(temp, JSON.stringify(written, void 0, 2) + '\n', { mode: FILE_MODE });
	try {
		renameSync(temp, target);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
	try {
		chmodSync(target, FILE_MODE);
	} catch {
		/* Windows: POSIX mode bits are advisory; the ACL is what protects the file. */
	}
	return written;
}

/**
 * Remove every schedule belonging to one peer.
 *
 * Used when a WeChat account logs out: its plans must not survive into whatever
 * account is scanned next. Kept in the storage layer so the caller can run it
 * even when no channel loop is mounted (a disconnected plugin has no loop).
 * @param root - plugin storage root.
 * @param peer - the peer identity that is leaving.
 * @returns how many entries were removed.
 */
function removeSchedulesForPeer(root, peer) {
	if (typeof peer !== 'string' || peer === '') return 0;
	const document = readSchedules(root);
	const remaining = document.entries.filter((entry) => entry.peer !== peer);
	const removed = document.entries.length - remaining.length;
	if (removed > 0) writeSchedules(root, { nextId: document.nextId, entries: remaining });
	return removed;
}

export {
	ACCOUNT_FILE, BINDINGS_FILE, BINDINGS_VERSION, CHANNEL_STATE_FILE, CHANNEL_STATE_VERSION,
	DIR_MODE, FILE_MODE, SCHEDULES_FILE, SCHEDULES_VERSION, STORE_DIR,
	accountPath, bindingsPath, channelStatePath, clearAccount, clearBinding, parseAccount,
	parseBinding, parseChannelState, parseInflight, parseSchedule, readAccount, readBindings,
	readChannelState, readSchedules, removeSchedulesForPeer, schedulesPath, storageRoot,
	writeAccount, writeBinding, writeBindings, writeChannelState, writeSchedules,
};
