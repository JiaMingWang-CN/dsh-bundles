/**
 * Redacted observability (plan §9).
 *
 * Everything recorded here is metadata: counts, latencies, codes, ids and
 * token totals. No message text, no state payload, no tool output and no
 * credential ever reaches a record — the redaction test pins that down.
 *
 * Pure module (no imports) so `node --test` can run it standalone.
 */

/** Ring size for recent decisions and fallbacks. */
const RECORD_LIMIT = 50;

/** The only record fields ever retained — anything else is dropped at the door. */
const RECORD_FIELDS = ["kind", "node", "reason", "decision", "accepted", "source", "code", "latencyMs", "spans", "removedTokens", "target"];

/** Numeric counters this plugin maintains. */
const COUNTER_KEYS = [
	"jevCalls",
	"jevCallFailures",
	"jevInputTokens",
	"jevOutputTokens",
	"compactionPlanned",
	"compactionCommitted",
	"compactionObserved",
	"compactionAborted",
	"unitsRemoved",
	"tokensRemoved",
	"unitsProtected",
	"unitsRestored",
	"faultDecisions",
	"faultRetries",
	"routeDecisions",
	"routeSwitches",
	"riskDecisions",
	"riskEscalations",
	"routeSkips",
	"budgetFallbacks",
	"nativeFallbacks"
];

/**
 * Create one audit sink.
 * @param {object} [options] - `logger` (winston-like `info`/`warn`), `now` clock.
 * @returns {object} the sink.
 */
function createAudit(options = {}) {
	const logger = options.logger;
	const now = options.now ?? (() => Date.now());
	const counters = Object.fromEntries(COUNTER_KEYS.map((key) => [key, 0]));
	const records = [];
	const latencies = [];

	function push(record) {
		const entry = { at: now() };
		for (const field of RECORD_FIELDS) if (record[field] !== undefined) entry[field] = record[field];
		records.push(entry);
		try {
			options.onRecord?.(entry);
		} catch {
			/* the durable log is observability only; never break the request path */
		}
		if (records.length > RECORD_LIMIT) records.shift();
		if (typeof entry.latencyMs === "number") {
			latencies.push(entry.latencyMs);
			if (latencies.length > RECORD_LIMIT) latencies.shift();
		}
	}

	return {
		/**
		 * Count one event and optionally keep a redacted record.
		 * @param {string} key - counter key.
		 * @param {object} [record] - redacted metadata to keep.
		 * @returns {void} nothing.
		 */
		count(key, record) {
			if (key in counters) counters[key] += 1;
			if (record !== undefined) push({ kind: key, ...record });
		},
		/**
		 * Add to a numeric total (token accounting).
		 * @param {string} key - counter key.
		 * @param {number} value - amount to add.
		 * @returns {void} nothing.
		 */
		add(key, value) {
			if (key in counters && Number.isFinite(value)) counters[key] += value;
		},
		/**
		 * Record a decision with its type-appropriate confidence evidence.
		 * @param {object} record - `node`, `decision`, `accepted`, `source`, optional `evidence`.
		 * @returns {void} nothing.
		 */
		decision(record) {
			push({ kind: "decision", ...record });
		},
		/**
		 * Record a fallback to the native path with its reason code.
		 * @param {string} reason - stable reason code.
		 * @param {object} [detail] - redacted context (ids, codes).
		 * @returns {void} nothing.
		 */
		fallback(reason, detail) {
			counters.nativeFallbacks += 1;
			push({ kind: "fallback", reason, ...detail });
		},
		/**
		 * Log one line without content (best effort; logging never throws).
		 * @param {string} level - `info` or `warn`.
		 * @param {string} message - redacted message.
		 * @returns {void} nothing.
		 */
		log(level, message) {
			try {
				logger?.[level]?.(message);
			} catch {
				/* observability must never break the request path */
			}
		},
		/**
		 * The published snapshot: explicit field whitelist only.
		 * @returns {object} redacted counters, latency aggregate and recent records.
		 */
		snapshot() {
			const sorted = [...latencies].sort((a, b) => a - b);
			return {
				counters: { ...counters },
				latency: {
					count: sorted.length,
					p50Ms: sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)],
					maxMs: sorted.length === 0 ? 0 : sorted[sorted.length - 1]
				},
				recent: records.slice(-10).map((record) => ({
					kind: record.kind,
					at: record.at,
					node: record.node,
					reason: record.reason,
					decision: record.decision,
					accepted: record.accepted,
					source: record.source,
					code: record.code
				}))
			};
		}
	};
}

export { COUNTER_KEYS, RECORD_LIMIT, createAudit };
