/**
 * Token usage for one session, and keyword search over session history.
 *
 * Both read the harness's own accounting rather than re-deriving it:
 *
 * - Usage comes from the `tokenUsage` session projection that `dsh-token-meter`
 *   registers: four buckets plus the last settled slot. Reasoning tokens are not
 *   a separate addition — the meter keeps them inside the output bucket, and the
 *   plan requires that they are never counted twice.
 * - Search goes through the `sessionQuery` service, filtered to durable user and
 *   assistant messages on the current surface. That filter is what keeps hidden
 *   reasoning and tool logs out of the results by construction, not by redaction
 *   after the fact.
 *
 * Cross-session aggregation is deliberately not attempted: the plan allows the
 * base query to come from the bound session alone, and silently summing logs
 * this plugin did not verify would be worse than saying it is unavailable.
 */

/** Page size used for one search request. */
const SEARCH_PAGE_SIZE = 10;

/** Longest snippet echoed back to the chat. */
const SNIPPET_CHARS = 200;

/** Event filters that restrict search to publishable conversation text. */
const VISIBLE_FILTERS = [
	{ kind: 'type', values: ['user/message', 'assistant/message'] },
	{ kind: 'surface', values: ['current'] },
];

/** Cross-session aggregation is not part of this build. */
const AGGREGATE_UNAVAILABLE = '本版本只提供当前绑定会话的用量；跨会话汇总不可用。';

/**
 * Read the bound session's usage totals.
 * @param options - the projections registry and the live session.
 * @returns `{ ok: true, totals, text }` or `{ ok: false, reason }`.
 */
function sessionUsage({ sessionProjections, session }) {
	if (sessionProjections === undefined || typeof sessionProjections.stateOf !== 'function' || session === undefined) {
		return { ok: false, reason: 'projection-unavailable' };
	}
	let state;
	try {
		state = sessionProjections.stateOf(session, 'tokenUsage');
	} catch (error) {
		return { ok: false, reason: 'projection-unavailable', detail: String(error?.message ?? error) };
	}
	if (state === undefined || state === null) return { ok: false, reason: 'no-usage-yet' };
	const totals = state.totals ?? {};
	const buckets = {
		input: numberOrZero(totals.uncachedInputTokens),
		cacheRead: numberOrZero(totals.cacheReadTokens),
		cacheWrite: numberOrZero(totals.cacheWriteTokens),
		output: numberOrZero(totals.outputTokens),
	};
	/* The meter's output bucket already contains any reasoning tokens. */
	const total = buckets.input + buckets.cacheRead + buckets.cacheWrite + buckets.output;
	return {
		ok: true,
		totals: buckets,
		total,
		last: state.last ?? null,
		text: [
			`本会话累计 Token：${formatCount(total)}`,
			`输入 ${formatCount(buckets.input)} · 缓存读取 ${formatCount(buckets.cacheRead)} · 缓存写入 ${formatCount(buckets.cacheWrite)} · 输出 ${formatCount(buckets.output)}`,
			'（输出已包含推理 Token，不重复加计。）',
			AGGREGATE_UNAVAILABLE,
		].join('\n'),
	};
}

/** One finite non-negative counter, else zero. */
function numberOrZero(value) {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** 1,234,567 · 12.3万 · 1.23亿 */
function formatCount(value) {
	if (value < 10000) return Math.round(value).toLocaleString('zh-CN');
	if (value < 100000000) return (value / 10000).toFixed(2).replace(/\.?0+$/, '') + '万';
	return (value / 100000000).toFixed(2).replace(/\.?0+$/, '') + '亿';
}

/**
 * Search the bound user's sessions for a literal keyword.
 *
 * Only sessions the harness lists as visible are searched, results are capped,
 * and a continuation cursor is returned so the caller can page instead of
 * loading an entire history at once.
 * @param options - the `sessionQuery` service, query text, page size, and cursor.
 * @returns `{ ok: true, items, nextCursor }` or `{ ok: false, reason, detail }`.
 */
async function searchHistory({ sessionQuery, query, limit = SEARCH_PAGE_SIZE, cursor } = {}) {
	const normalized = typeof query === 'string' ? query.trim() : '';
	if (normalized === '') return { ok: false, reason: 'query-missing' };
	if (sessionQuery === undefined || typeof sessionQuery.searchSessions !== 'function') {
		return { ok: false, reason: 'search-unavailable' };
	}
	const pageSize = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 20) : SEARCH_PAGE_SIZE;
	try {
		const page = await sessionQuery.searchSessions({
			query: normalized,
			eventFilters: VISIBLE_FILTERS,
			limit: pageSize,
			...(typeof cursor === 'string' && cursor !== '' ? { cursor } : {}),
		});
		const items = (Array.isArray(page?.items) ? page.items : [])
			.filter((hit) => hit?.header?.id !== undefined && hit?.bestMatch?.sessionId === hit.header.id)
			.map((hit) => ({
				sessionId: hit.header.id,
				shortId: String(hit.header.id).slice(-8),
				cwd: typeof hit.header.cwd === 'string' ? hit.header.cwd : '',
				type: typeof hit.bestMatch.type === 'string' ? hit.bestMatch.type : '',
				snippet: truncate(String(hit.bestMatch.snippet ?? ''), SNIPPET_CHARS),
			}));
		return { ok: true, items, nextCursor: typeof page?.nextCursor === 'string' ? page.nextCursor : '', query: normalized };
	} catch (error) {
		const code = typeof error?.code === 'string' ? error.code : '';
		if (code === 'SESSION_QUERY_STALE_CURSOR') return { ok: false, reason: 'stale-cursor' };
		if (code === 'SESSION_QUERY_INVALID_LIMIT') return { ok: false, reason: 'invalid-limit' };
		return { ok: false, reason: 'search-failed', detail: String(error?.message ?? error) };
	}
}

/** Truncate on code-point boundaries so a snippet never splits a character. */
function truncate(text, limit) {
	const points = [...text];
	return points.length <= limit ? text : points.slice(0, limit).join('') + '…';
}

export {
	AGGREGATE_UNAVAILABLE, SEARCH_PAGE_SIZE, SNIPPET_CHARS, VISIBLE_FILTERS,
	formatCount, numberOrZero, searchHistory, sessionUsage, truncate,
};
