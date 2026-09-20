/**
 * dsh-client-ui-usage-stats — host half.
 *
 * Folds every persisted session log into provider/model token totals, because no
 * shipped projection carries a route dimension: `tokenUsage` keeps four buckets
 * for one session, and `modelSelection` keeps only the last used route.
 *
 * The fold reads the session logs itself instead of going through
 * `ctx.sessionQuery`. That service replay-validates an entire log per session,
 * which measured at 5–34 s for this corpus (~50 MB); decoding the same logs
 * directly takes ~0.4 s, and a filesystem change signature then lets every later
 * panel open reuse the previous result in single-digit milliseconds — by far the
 * dominant cost of this feature. A log whose path, size, and mtime are unchanged
 * is never decoded twice, so a running session costs one parse per append.
 *
 * The browser half only renders; numbers are formatted here, because the client
 * execution environment does not guarantee `Intl`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

/** Route the browser half reads; a package-owned path, so no shell route is shadowed. */
const SUMMARY_PATH = '/plugins/ui-usage-stats/summary';

/** Resolve the harness session store, honoring an explicit `DSH_HOME`. */
function sessionsRoot(env = process.env, home = homedir()) {
	return join(env.DSH_HOME || join(home, '.dsh'), 'sessions');
}

/** Where the harness keeps persisted session logs (`$DSH_HOME/sessions`). */
const SESSIONS_ROOT = sessionsRoot();

/** Zstandard frame magic: session logs are an append-only sequence of frames. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** How long a rebuilt report stays fresh, so a repeat open stays free. */
const REPORT_TTL_MS = 15000;

/** Zero-valued accounting buckets plus the counters a group carries. */
function zeroGroup() {
	return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, requests: 0, sessions: 0 };
}

/** Total tokens of one group: prompt-side buckets plus output. Reasoning tokens
 *  are reported inside `outputTokens`, so they stay a breakdown column and are
 *  never added to the total. */
function totalOf(group) {
	return group.input + group.cacheRead + group.cacheWrite + group.output;
}

/** One finite non-negative counter from a provider usage report, else 0. */
function countOrZero(value) {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Provider-reported usage mapped onto the accounting buckets. */
function bucketsOf(usage) {
	return {
		input: countOrZero(usage.inputTokens),
		cacheRead: countOrZero(usage.cacheReadTokens),
		cacheWrite: countOrZero(usage.cacheWriteTokens),
		output: countOrZero(usage.outputTokens),
		reasoning: countOrZero(usage.reasoningTokens),
	};
}

/** 1,234,567 · 12.3万 · 1.23亿 */
function formatCount(value) {
	if (value < 10000) return Math.round(value).toLocaleString('zh-CN');
	if (value < 100000000) return (value / 10000).toFixed(2).replace(/\.?0+$/, '') + '万';
	return (value / 100000000).toFixed(2).replace(/\.?0+$/, '') + '亿';
}

/** Display strings for one group's counters (the client has no `Intl`). */
function textOf(group) {
	return {
		total: formatCount(totalOf(group)),
		input: formatCount(group.input),
		cacheRead: formatCount(group.cacheRead),
		cacheWrite: formatCount(group.cacheWrite),
		output: formatCount(group.output),
		reasoning: formatCount(group.reasoning),
		requests: String(group.requests),
		sessions: String(group.sessions),
	};
}

/** Percentage of the corpus total, one decimal place. */
function shareOf(value, grand) {
	return grand <= 0 ? 0 : Math.round((value / grand) * 1000) / 10;
}

/** Every persisted session log under `root`, depth-first. */
function walkFiles(root) {
	const found = [];
	let entries;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return found;
	}
	for (const entry of entries) {
		const full = join(root, entry.name);
		if (entry.isDirectory()) found.push(...walkFiles(full));
		else if (entry.isFile() && entry.name === 'session.v3.jsonl.zstd') found.push(full);
	}
	return found;
}

/**
 * Decode one session log into its header row plus its events.
 *
 * The log is a sequence of Zstandard frames, each holding complete JSONL records;
 * a frame still being written is incomplete and is skipped, exactly as the
 * persistence layer's own reader does. Rows without a `type` are ignored, so a
 * format this decoder does not know yields no sessions rather than wrong numbers.
 * @param path - absolute path of the `.jsonl.zstd` session log.
 * @returns the parsed session, or undefined when the log has no readable header.
 */
function parseSessionLog(path) {
	let bytes;
	try {
		bytes = readFileSync(path);
	} catch {
		return undefined;
	}
	const starts = [];
	let cursor = 0;
	while ((cursor = bytes.indexOf(ZSTD_MAGIC, cursor)) !== -1) {
		starts.push(cursor);
		cursor += ZSTD_MAGIC.length;
	}
	let header;
	const events = [];
	for (let index = 0; index < starts.length; index += 1) {
		const part = bytes.subarray(starts[index], index + 1 < starts.length ? starts[index + 1] : bytes.length);
		let plain;
		try {
			plain = zstdDecompressSync(part).toString('utf8');
		} catch {
			continue;
		}
		for (const line of plain.split('\n')) {
			if (line === '') continue;
			let row;
			try {
				row = JSON.parse(line);
			} catch {
				continue;
			}
			if (row.type === 'session') {
				header = row;
				continue;
			}
			events.push(row.event ?? row);
		}
	}
	if (header === undefined) return undefined;
	return { header, events };
}

/**
 * Fold one session's own events into per-route buckets.
 *
 * Attribution follows the settlement: each assistant reply carries the provider
 * and model that produced it, with the latest `request/header` as the fallback
 * when a reply has no provenance. A repeated settlement in one `(turn, step)`
 * slot replaces the previous one rather than adding, and `llm/retry-started`
 * closes that slot, which is the `tokenUsage` projection's own accounting — so a
 * retried attempt stays exactly one charge.
 * @param events - the session's events, in log order.
 * @returns entries of `[routeKey, group]`, routeKey being `provider\u0000model`.
 */
/** Remove a slot's previous settlement before recording its replacement. */
function withdrawSlot(groups, slot) {
	if (slot === undefined || !slot.counted) return;
	const group = groups.get(slot.key);
	if (group === undefined) return;
	group.input -= slot.buckets.input;
	group.cacheRead -= slot.buckets.cacheRead;
	group.cacheWrite -= slot.buckets.cacheWrite;
	group.output -= slot.buckets.output;
	group.reasoning -= slot.buckets.reasoning;
	group.requests -= 1;
	if (group.requests === 0 && totalOf(group) === 0 && group.reasoning === 0) groups.delete(slot.key);
}

function foldSession(events) {
	const groups = new Map();
	let route;
	let slot;
	for (const event of events) {
		if (event === undefined) continue;
		if (event.type === 'request/header') {
			const config = event.data?.header?.config;
			if (config !== undefined && typeof config.provider === 'string' && typeof config.model === 'string') {
				route = { provider: config.provider, model: config.model };
			}
			continue;
		}
		if (event.type === 'llm/retry-started') {
			const turn = event.data?.turn;
			const step = event.data?.step;
			if (slot !== undefined && slot.turn === turn && slot.step === step) {
				/* The failed attempt consumed tokens, but the retry is still one logical request. */
				if (slot.counted) {
					const group = groups.get(slot.key);
					if (group !== undefined) group.requests -= 1;
				}
				slot = undefined;
			}
			continue;
		}
		if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue;
		const turn = event.data?.turn;
		const step = event.data?.step;
		const usage = event.type === 'assistant/message' ? event.data?.usage : undefined;
		const source = event.type === 'assistant/message' ? event.data?.message?.source : undefined;
		let provider;
		let model;
		if (source !== undefined && typeof source.provider === 'string' && typeof source.model === 'string') {
			provider = source.provider;
			model = source.model;
		} else if (route !== undefined) {
			provider = route.provider;
			model = route.model;
		} else {
			provider = 'unknown';
			model = 'unknown';
		}
		const key = provider + '\u0000' + model;
		/* Withdraw this slot's previous settlement before recording the new one. */
		if (slot !== undefined && slot.turn === turn && slot.step === step) withdrawSlot(groups, slot);
		if (usage === undefined) {
			slot = { turn, step, key, counted: false };
			continue;
		}
		const buckets = bucketsOf(usage);
		let group = groups.get(key);
		if (group === undefined) {
			group = zeroGroup();
			groups.set(key, group);
		}
		group.input += buckets.input;
		group.cacheRead += buckets.cacheRead;
		group.cacheWrite += buckets.cacheWrite;
		group.output += buckets.output;
		group.reasoning += buckets.reasoning;
		group.requests += 1;
		slot = { turn, step, key, counted: true, buckets };
	}
	return [...groups];
}

/** Add one folded session's entries into the corpus-wide rollups. */
function mergeSession(entries, byRoute, byModel) {
	for (const [key, group] of entries) {
		const sep = key.indexOf('\u0000');
		const provider = key.slice(0, sep);
		const model = key.slice(sep + 1);
		let route = byRoute.get(key);
		if (route === undefined) {
			route = { provider, model, ...zeroGroup() };
			byRoute.set(key, route);
		}
		let modelEntry = byModel.get(model);
		if (modelEntry === undefined) {
			modelEntry = { model, providers: new Set(), ...zeroGroup() };
			byModel.set(model, modelEntry);
		}
		for (const target of [route, modelEntry]) {
			target.input += group.input;
			target.cacheRead += group.cacheRead;
			target.cacheWrite += group.cacheWrite;
			target.output += group.output;
			target.reasoning += group.reasoning;
			target.requests += group.requests;
			target.sessions += 1;
		}
		modelEntry.providers.add(provider);
	}
}

/** One session's decoded fold, kept until its log file changes. */
const SESSION_CACHE = new Map();
/** A finished report, reused while the store signature and freshness hold. */
const REPORT_CACHE = new Map();

/**
 * Read the corpus, decoding only the logs whose size or mtime moved.
 *
 * The signature doubles as the reuse decision and the cheap "did anything
 * change?" probe: `stat` over every log costs ~3 ms, while decoding the corpus
 * costs ~0.4 s and re-validating it through `ctx.sessionQuery` costs seconds.
 * @param includeSubagents - count subagent sessions as their own corpus entries.
 * @returns rollups plus decode, skip, and exclusion counts.
 */
function collect(includeSubagents) {
	const files = walkFiles(SESSIONS_ROOT);
	const signature = [];
	const sessions = [];
	const byRoute = new Map();
	const byModel = new Map();
	const totals = zeroGroup();
	const live = new Set();
	let decoded = 0;
	let skipped = 0;
	let excluded = 0;
	for (const path of files) {
		let info;
		try {
			info = statSync(path);
		} catch {
			continue;
		}
		signature.push(`${path}:${info.size}:${info.mtimeMs}`);
		live.add(path);
		let entry = SESSION_CACHE.get(path);
		if (entry === undefined || entry.size !== info.size || entry.mtimeMs !== info.mtimeMs) {
			const parsed = parseSessionLog(path);
			if (parsed === undefined) {
				skipped += 1;
				SESSION_CACHE.delete(path);
				continue;
			}
			entry = {
				size: info.size,
				mtimeMs: info.mtimeMs,
				/* Subagent sessions are told apart by their directory name: the header
				 * row is written at creation, before the harness knows a session is
				 * delegated, so `origin` is absent from every persisted log. Main
				 * sessions are `session-<uuid>`, delegated children are bare uuids. */
				subagent: !basename(dirname(path)).startsWith('session-'),
				id: typeof parsed.header.id === 'string' ? parsed.header.id : basename(dirname(path)),
				agentPreset: typeof parsed.header.agentPreset === 'string' ? parsed.header.agentPreset : '',
				cwd: typeof parsed.header.cwd === 'string' ? parsed.header.cwd : '',
				createdAt: Number(parsed.header.createdAt) || 0,
				entries: foldSession(parsed.events),
			};
			let requests = 0;
			let total = 0;
			for (const [, group] of entry.entries) {
				requests += group.requests;
				total += totalOf(group);
			}
			entry.requests = requests;
			entry.total = total;
			SESSION_CACHE.set(path, entry);
			decoded += 1;
		}
		/* A session with no settled usage still belongs in the index: the panel must
		 * be able to explain why the corpus total did not move. */
		if (entry.entries.length === 0 && !entry.subagent) {
			sessions.push({
				id: entry.id,
				shortId: entry.id.slice(-8),
				subagent: false,
				agentPreset: entry.agentPreset,
				workspace: workspaceOf(entry.cwd),
				createdAt: entry.createdAt,
				counted: false,
			});
			continue;
		}
		if (entry.subagent && !includeSubagents) {
			excluded += 1;
			continue;
		}
		mergeSession(entry.entries, byRoute, byModel);
		for (const [, group] of entry.entries) {
			totals.input += group.input;
			totals.cacheRead += group.cacheRead;
			totals.cacheWrite += group.cacheWrite;
			totals.output += group.output;
			totals.reasoning += group.reasoning;
		}
		totals.requests += entry.requests;
		totals.sessions += 1;
		sessions.push({
			id: entry.id,
			shortId: entry.id.slice(-8),
			subagent: entry.subagent,
			agentPreset: entry.agentPreset,
			workspace: workspaceOf(entry.cwd),
			createdAt: entry.createdAt,
			counted: true,
			requests: entry.requests,
			total: entry.total,
		});
	}
	for (const path of [...SESSION_CACHE.keys()]) {
		if (!live.has(path)) SESSION_CACHE.delete(path);
	}
	signature.sort();
	return {
		byRoute,
		byModel,
		sessions,
		totals,
		decoded,
		skipped,
		excluded,
		listed: files.length,
		signature: signature.join('|'),
	};
}

/** Last path segment of a session's working directory, for the session view. */
function workspaceOf(cwd) {
	if (cwd === '') return '';
	const parts = cwd.split(/[\\/]/).filter((part) => part !== '');
	return parts.length === 0 ? '' : parts[parts.length - 1];
}

/**
 * Serialize the rollups into the plain JSON the browser half renders.
 * Every user-visible number is formatted here: only JSON scalars cross the wire,
 * and the client sandbox has no `Intl`.
 */
function report(collected, generatedAt) {
	const grand = totalOf(collected.totals);
	const byProvider = new Map();
	for (const route of collected.byRoute.values()) {
		let provider = byProvider.get(route.provider);
		if (provider === undefined) {
			provider = {
				provider: route.provider,
				input: 0,
				cacheRead: 0,
				cacheWrite: 0,
				output: 0,
				reasoning: 0,
				requests: 0,
				sessions: 0,
				models: [],
			};
			byProvider.set(route.provider, provider);
		}
		for (const field of ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning', 'requests', 'sessions']) {
			provider[field] += route[field];
		}
		const total = totalOf(route);
		provider.models.push({
			model: route.model,
			requests: route.requests,
			sessions: route.sessions,
			total,
			share: shareOf(total, grand),
			text: textOf(route),
		});
	}
	const providers = [...byProvider.values()]
		.map((provider) => {
			const total = totalOf(provider);
			return {
				...provider,
				total,
				share: shareOf(total, grand),
				text: textOf(provider),
				models: provider.models.sort((left, right) => right.total - left.total),
			};
		})
		.sort((left, right) => right.total - left.total);
	const models = [...collected.byModel.values()]
		.map((entry) => {
			const total = totalOf(entry);
			return {
				model: entry.model,
				providers: [...entry.providers].sort(),
				requests: entry.requests,
				sessions: entry.sessions,
				total,
				share: shareOf(total, grand),
				text: textOf(entry),
			};
		})
		.sort((left, right) => right.total - left.total);
	const sessionsList = collected.sessions
		.filter((session) => session.counted === true && (session.total > 0 || session.requests > 0))
		.sort((left, right) => right.total - left.total)
		.map((session) => ({
			id: session.id,
			shortId: session.shortId,
			subagent: session.subagent,
			agentPreset: session.agentPreset,
			workspace: session.workspace,
			createdAtText: session.createdAt > 0
				? new Date(session.createdAt).toLocaleString('zh-CN', { hour12: false })
				: '',
			requestsText: String(session.requests),
			totalText: formatCount(session.total),
		}));
	return {
		ok: true,
		generatedAt,
		generatedAtText: new Date(generatedAt).toLocaleTimeString('zh-CN', { hour12: false }),
		sessions: {
			listed: collected.listed,
			counted: collected.totals.sessions,
			skipped: collected.skipped,
			excluded: collected.excluded,
			decoded: collected.decoded,
		},
		totals: {
			requests: collected.totals.requests,
			sessions: collected.totals.sessions,
			total: totalOf(collected.totals),
			text: textOf(collected.totals),
		},
		providers,
		models,
		sessionsList,
	};
}

/** JSON response; `no-store` keeps a live fold out of every cache. */
function sendJson(response, status, payload) {
	response.statusCode = status;
	response.setHeader('content-type', 'application/json; charset=utf-8');
	response.setHeader('cache-control', 'no-store');
	response.end(JSON.stringify(payload));
}

/** Stable Cordis plugin name. */
const name = 'ui-usage-stats';
/** The web server is the only dependency: this half reads the logs itself. */
const inject = ['webServer'];

/**
 * Host half body: one JSON route serving the folded corpus. A repeat open within
 * the freshness window is answered from the last report, so the panel never pays
 * the decode cost twice in a row.
 * @param ctx - host context.
 */
function apply(ctx) {
	ctx.effect(() => ctx.webServer.register({
		kind: 'exact',
		path: SUMMARY_PATH,
		handler: (request, response) => {
			const started = Date.now();
			if (request.method !== 'GET' && request.method !== 'HEAD') {
				response.statusCode = 405;
				response.setHeader('allow', 'GET');
				response.end();
				return;
			}
			const url = new URL(request.url ?? SUMMARY_PATH, 'http://localhost');
			const includeSubagents = url.searchParams.get('includeSubagents') !== 'false';
			const force = url.searchParams.get('refresh') === 'true';
			const signature = storeSignature();
			const cached = REPORT_CACHE.get('summary');
			const fresh = cached !== undefined
				&& cached.signature === signature
				&& cached.includeSubagents === includeSubagents
				&& Date.now() - cached.generatedAt < REPORT_TTL_MS;
			if (!force && fresh) {
				sendJson(response, 200, cached.payload);
				console.error(`usage-stats: reused in ${Date.now() - started}ms`);
				return;
			}
			try {
				const collected = collect(includeSubagents);
				const payload = report(collected, Date.now());
				REPORT_CACHE.set('summary', {
					signature: collected.signature,
					includeSubagents,
					generatedAt: payload.generatedAt,
					payload,
				});
				sendJson(response, 200, payload);
				console.error(`usage-stats: folded in ${Date.now() - started}ms (decoded ${collected.decoded}/${collected.listed} logs)`);
			} catch (error) {
				console.error('usage-stats: corpus read failed', error);
				sendJson(response, 500, { ok: false, reason: 'read-failed' });
			}
		},
	}), 'ui-usage-stats: GET ' + SUMMARY_PATH);
}

/**
 * Cheap store fingerprint used for the freshness decision alone.
 * @returns one token per session directory entry.
 */
function storeSignature() {
	const parts = [];
	for (const path of walkFiles(SESSIONS_ROOT)) {
		try {
			const info = statSync(path);
			parts.push(`${path}:${info.size}:${info.mtimeMs}`);
		} catch {
			parts.push(`${path}:?`);
		}
	}
	parts.sort();
	return parts.join('|');
}

const testing = { foldSession, sessionsRoot, walkFiles };

export { apply, inject, name, testing };
