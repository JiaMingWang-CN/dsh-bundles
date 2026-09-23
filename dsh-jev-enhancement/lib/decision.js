/**
 * Decision Assistance: three bounded decision nodes (plan §7).
 *
 * Every node runs deterministic rules first and calls Jev only where judgment
 * is genuinely needed. Jev advice is adopted only through the local
 * whitelists and thresholds below, and each composition is written so the
 * native decision is computed FIRST: this layer can add a bounded retry,
 * switch to a whitelisted route, or escalate `allow` to `ask` — it can never
 * loosen a denial, bypass an approval, or widen the action set.
 *
 * Pure module: the Jev call (`ask`) is injected so `node --test` can run it
 * standalone.
 */

import { faultQuestions, mapFault, mapRisks, mapRoute, riskQuestions, routeQuestions } from "./questions.js";

/** Failure codes already known to be transient; no Jev call needed. */
const TRANSIENT_CODES = ["RATE_LIMIT", "TIMEOUT", "TRANSPORT", "SERVER", "EMPTY_RESPONSE", "QUOTA_EXCEEDED"];

/** Failure codes already known to be credential problems. */
const AUTH_CODES = ["AUTH", "INVALID_CREDENTIAL"];

/** Failure codes already known to be input problems. */
const INPUT_CODES = ["INVALID_REQUEST", "CONTEXT_WINDOW_EXCEEDED"];

/** Risk dimensions that escalate `allow` to `ask`; a plain write is recorded only. */
const ESCALATING_RISKS = ["destructive", "external", "irreversible"];

/** Deterministic tool-name hints per risk dimension. */
const TOOL_RISK_HINTS = {
	write: ["write", "edit", "patch", "replace", "create", "mkdir", "move", "rename", "str_replace"],
	destructive: ["delete", "remove", "rm", "drop", "clean", "reset", "revert"],
	external: ["web", "fetch", "search", "send", "post", "publish", "push", "upload", "request"],
	irreversible: ["force", "purge", "truncate", "hard"]
};

/** Deterministic command patterns per risk dimension (bash-style commands). */
const COMMAND_RISK_PATTERNS = {
	write: [/\btee\b/, /\bcp\b/, /\bmv\b/, />>/, /(?<!>)>(?!\s*>)/, /\bsed -i\b/],
	destructive: [/(?<![$\w.])rm\s+(?:-[\w]+\s+)*\S+/, /&\s*\$[a-z_][\w]*\s+-(?:rf|fr)\b/, /\bremove-item\b(?:\s|$)/, /\bdel\s+\S+/, /\berase\s+\S+/, /\bgit\s+(?:reset|clean)\b/, /\bdrop\s+(?:table|database)\b/i],
	external: [/\bgit\s+push\b/, /\bcurl\b/, /\bwget\b/, /\bnpm\s+publish\b/, /\bpip\s+upload\b/, /\bssh\b/, /\bscp\b/],
	irreversible: [/--force\b/, /-f\b.*\brm\b/, /\btruncate\b/i, /\bdelete\s+from\b/i, /\bgit\s+push\b.*--force/]
};

/** Bounded prose of one failure for the state payload. */
const MAX_FACT_CHARS = 400;

function isObject(value) {
	return typeof value === "object" && value !== null;
}

function boundFacts(value) {
	if (typeof value !== "string") return "";
	return value.length > MAX_FACT_CHARS ? value.slice(0, MAX_FACT_CHARS) : value;
}

/**
 * Deterministic fault class for one failure code.
 * @param {object} failure - serializable `LlmFailure` facts.
 * @returns {"transient" | "rate_limit" | "auth" | "input_problem" | "unknown"} the class.
 */
function classifyByRule(failure) {
	const code = typeof failure?.code === "string" ? failure.code : "";
	if (code === "RATE_LIMIT" || code === "QUOTA_EXCEEDED") return "rate_limit";
	if (TRANSIENT_CODES.includes(code)) return "transient";
	if (AUTH_CODES.includes(code)) return "auth";
	if (INPUT_CODES.includes(code)) return "input_problem";
	return "unknown";
}

/**
 * Fault classification node (plan §7.1 row 1).
 *
 * The native action is decided by the caller's `next()`; this function only
 * says whether a bounded extra retry is justified for a failure the
 * deterministic rules cannot classify. The retry ceiling is the provider's own
 * resolved policy budget plus the per-model `maxExtraRetries` — the existing
 * retry counts and idempotency limits are never exceeded.
 * @param {object} input - `failure`, `retryPolicy`, `failuresSeen`, `extraRetriesUsed`, `policy`, `ask`, `signal`.
 * @returns {Promise<{ action: "retry" | "delegate", category: string, source: string }>} the advice.
 */
async function faultDecision(input) {
	const { failure, retryPolicy, failuresSeen = 0, extraRetriesUsed = 0, policy, ask, signal } = input;
	const limits = policy.decision.acceptanceByNode.faultClassification;
	const category = classifyByRule(failure);
	if (category !== "unknown") return { action: "delegate", category, source: "rule" };
	const result = await ask({
		state: {
			failure: {
				code: boundFacts(failure?.code),
				status: typeof failure?.status === "number" ? failure.status : null,
				message: boundFacts(failure?.message)
			},
			attempts: failuresSeen
		},
		questions: faultQuestions(),
		signal
	});
	const judged = mapFault(result.answers.fault_category, limits.minConfidence);
	const transient = judged === "transient" || judged === "rate_limit";
	const bounded = extraRetriesUsed < limits.maxExtraRetries;
	const withinPolicy = isObject(retryPolicy) && retryPolicy.mode === "normal" && failuresSeen < retryPolicy.maxRetries;
	if (transient && bounded && withinPolicy) return { action: "retry", category: judged, source: "jev" };
	return { action: "delegate", category: judged, source: "jev" };
}

/**
 * Route-selection node (plan §7.1 row 2).
 *
 * Candidates are the configured alternates intersected with the routes DSH
 * actually has an adapter for; anything outside that whitelist can never be
 * returned, whatever Jev answers. The verdict distinguishes an empty run
 * (nothing to judge — no Jev call) from a consulted one, so the audit trail can
 * tell real judgments apart from skips.
 * @param {object} input - `current`, `available`, `policy`, `triggered`, `task`, `ask`, `signal`.
 * @returns {Promise<{ kind: "skip", reason: string } | { kind: "keep" } | { kind: "switch", provider: string, model: string, key: string }>} the verdict.
 */
async function routeDecision(input) {
	const { current, available, policy, triggered = false, ask, signal } = input;
	const limits = policy.decision.acceptanceByNode.routeSelection;
	const availableKeys = new Set(available.map((route) => route.provider + "/" + route.model));
	const whitelist = limits.candidates.filter((candidate) => availableKeys.has(candidate.key));
	/* Deterministic first: no trigger or nothing to pick means no judgment call. */
	if (!triggered) return { kind: "skip", reason: "not-triggered" };
	if (whitelist.length < 1) return { kind: "skip", reason: "no-candidates" };
	const keys = whitelist.map((candidate) => candidate.key);
	const result = await ask({
		state: {
			task: boundFacts(input.task),
			currentRoute: current.provider + "/" + current.model,
			candidates: keys,
			recentFailures: Array.isArray(input.recentFailures) ? input.recentFailures.slice(-3).map(boundFacts) : []
		},
		questions: routeQuestions(keys),
		signal
	});
	const chosen = mapRoute(result.answers.route_choice, keys, limits.minConfidence);
	if (chosen === null) return { kind: "keep" };
	const candidate = whitelist.find((entry) => entry.key === chosen);
	return candidate === undefined ? { kind: "keep" } : { kind: "switch", provider: candidate.provider, model: candidate.model, key: candidate.key };
}

/**
 * Deterministic risk dimensions for one tool call.
 * @param {string} name - tool name.
 * @param {unknown} args - parsed tool arguments.
 * @returns {string[]} risk dimensions seen in the call shape.
 */
function detectRiskByRule(name, args) {
	const dimensions = new Set();
	const toolName = typeof name === "string" ? name.toLowerCase() : "";
	for (const [dimension, hints] of Object.entries(TOOL_RISK_HINTS)) {
		if (hints.some((hint) => toolName.includes(hint))) dimensions.add(dimension);
	}
	let commandText = "";
	if (typeof args === "string") commandText = args;
	else if (isObject(args)) {
		for (const key of ["command", "cmd", "script", "path", "file", "pattern", "url"]) {
			const value = args[key];
			if (typeof value === "string") commandText += "\n" + value;
		}
	}
	/* Quoted prose and file names are operands, not commands. Keep a placeholder
	 * so `rm "path"` still has an argument after removing the quoted text. */
	const lowered = commandText.replace(/'(?:''|[^'])*'|"(?:`.|[^"])*"/g, " ARG ").toLowerCase();
	for (const [dimension, patterns] of Object.entries(COMMAND_RISK_PATTERNS)) {
		if (patterns.some((pattern) => pattern.test(lowered))) dimensions.add(dimension);
	}
	return [...dimensions];
}

/**
 * Risk-judgment node (plan §7.1 row 3).
 *
 * The advice can only escalate `allow` to `ask` (further confirmation); it can
 * never allow what the permission and approval rules would refuse.
 * @param {object} input - `name`, `args`, `policy`, `ask`, `signal`.
 * @returns {Promise<{ escalate: boolean, risks: string[], source: string }>} the advice.
 */
async function riskDecision(input) {
	const { name, args, policy, ask, signal } = input;
	const limits = policy.decision.acceptanceByNode.riskJudgment;
	const ruled = detectRiskByRule(name, args);
	if (ruled.some((dimension) => ESCALATING_RISKS.includes(dimension))) {
		return { escalate: true, risks: ruled, source: "rule" };
	}
	/* A partial command is not evidence that the unseen suffix is safe. */
	let serialized;
	try {
		serialized = JSON.stringify(args);
	} catch {
		return { escalate: false, risks: [], source: "insufficient-evidence" };
	}
	if (typeof serialized !== "string" || serialized.length > MAX_FACT_CHARS) {
		return { escalate: false, risks: [], source: "insufficient-evidence" };
	}
	if (ruled.length > 0) return { escalate: false, risks: ruled, source: "rule" };
	const result = await ask({
		state: {
			tool: boundFacts(name),
			arguments: serialized
		},
		questions: riskQuestions(),
		signal
	});
	const risks = mapRisks(result.answers, limits.minNoul);
	return {
		escalate: risks.some((dimension) => ESCALATING_RISKS.includes(dimension)),
		risks,
		source: "jev"
	};
}

export {
	AUTH_CODES,
	COMMAND_RISK_PATTERNS,
	ESCALATING_RISKS,
	INPUT_CODES,
	TOOL_RISK_HINTS,
	TRANSIENT_CODES,
	classifyByRule,
	detectRiskByRule,
	faultDecision,
	riskDecision,
	routeDecision
};
