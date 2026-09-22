/**
 * TypeSafe System One (Jev) adapter — the plugin's ONLY external API boundary.
 *
 * Contract source: the official TypeSafe API Reference
 * (https://docs.typesafe.ai/api), Quick start
 * (https://docs.typesafe.ai/introduction/quickstart) and Models
 * (https://docs.typesafe.ai/models); the recording lives in
 * `docs/typesafe-api-contract.md`. Two contract rules are enforced here and
 * nowhere else may bypass them:
 *
 * - the request carries exactly the documented fields `state`, `model`,
 *   `questions` — no field guessing, and no retry with a reshaped body after a
 *   `422` (a contract failure disables the enhancement instead);
 * - unknown response fields are ignored, missing answers are per-question
 *   `unknown`, and Choice `probabilities`/`confidence` are never mixed with
 *   Noul's `noul` value or Score's `score`.
 *
 * Pure module: transport (`fetchImpl`), key resolution (`resolveKey`) and
 * logging are injected so `node --test` can run it standalone.
 */

/** Request endpoint from the official API Reference. */
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** Plugin-internal evidence budget: state is text-only and bounded well below the documented request budget. */
const MAX_STATE_CHARS = 20000;

/** Plugin-internal question cap per call (call budget control, not an API limit). */
const MAX_QUESTIONS_PER_CALL = 64;

/** Stable failure classes this plugin routes on. */
const ERROR_CODES = [
	"credential-missing",
	"auth",
	"contract",
	"invalid-response",
	"rate-limit",
	"overloaded",
	"transport",
	"timeout",
	"unavailable",
	"cancelled",
	"budget",
	"circuit-open"
];

/** One classified adapter failure; `code` is the routing key. */
class JevError extends Error {
	/**
	 * @param {string} code - stable machine code from {@link ERROR_CODES}.
	 * @param {string} message - human-readable summary (never carries secrets).
	 * @param {object} [options] - optional facts: `status`, `retryable`, `cause`.
	 */
	constructor(code, message, options = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "JevError";
		this.code = code;
		this.status = options.status;
		this.retryable = options.retryable === true;
	}
}

/** Map one HTTP status onto the stable failure classes. */
function mapStatus(status) {
	if (status === 401) return "auth";
	if (status === 422) return "contract";
	if (status === 429) return "rate-limit";
	if (status === 529) return "overloaded";
	if (status >= 500) return "unavailable";
	return "unavailable";
}

/**
 * Validate one response body against the questions that were asked.
 *
 * Per-question tolerance: a missing or malformed answer becomes `unknown`
 * rather than failing the whole call, and unknown extra fields are ignored.
 * @param {unknown} payload - decoded response body.
 * @param {Record<string, object>} questions - the questions that were sent.
 * @returns {{ model: string, answers: Record<string, object>, usage: object }} normalized result.
 */
function validateResponse(payload, questions) {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		throw new JevError("invalid-response", "Jev response body is not an object");
	}
	const answers = typeof payload.answers === "object" && payload.answers !== null ? payload.answers : null;
	if (answers === null) throw new JevError("invalid-response", "Jev response body has no answers map");
	const usageSource = typeof payload.usage === "object" && payload.usage !== null ? payload.usage : {};
	const usage = {
		inputTokens: Number.isFinite(usageSource.input_tokens) ? usageSource.input_tokens : 0,
		outputTokens: Number.isFinite(usageSource.output_tokens) ? usageSource.output_tokens : 0
	};
	const normalized = {};
	for (const [id, question] of Object.entries(questions)) {
		const answer = answers[id];
		if (typeof answer !== "object" || answer === null || answer.type !== question.type) {
			normalized[id] = { type: question.type, unknown: true };
			continue;
		}
		normalized[id] = normalizeAnswer(question.type, answer);
	}
	return {
		model: typeof payload.model === "string" ? payload.model : "",
		answers: normalized,
		usage
	};
}

/**
 * Normalize one answer of a known question type; out-of-range or missing
 * fields degrade to `unknown: true` instead of being guessed.
 * @param {string} type - question type (`choice`, `noul`, `score`).
 * @param {object} answer - the typed answer object.
 * @returns {object} normalized answer.
 */
function normalizeAnswer(type, answer) {
	const unknown = { type, unknown: true };
	const probability01 = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined);
	if (type === "noul") {
		const noul = probability01(answer.noul);
		return noul === undefined ? unknown : { type, noul };
	}
	if (type === "choice") {
		const choice = typeof answer.choice === "string" ? answer.choice : "";
		const confidence = probability01(answer.confidence);
		const probabilities = normalizeProbabilities(answer.probabilities);
		if (choice === "" || confidence === undefined || probabilities === undefined) return unknown;
		if (!(choice in probabilities)) return unknown;
		return { type, choice, confidence, probabilities };
	}
	if (type === "score") {
		const score = typeof answer.score === "number" && Number.isFinite(answer.score) ? answer.score : undefined;
		const confidence = probability01(answer.confidence);
		const probabilities = normalizeProbabilities(answer.probabilities);
		if (score === undefined || confidence === undefined || probabilities === undefined) return unknown;
		return { type, score, confidence, probabilities };
	}
	return unknown;
}

/**
 * Normalize a probability map: every value must be a number in [0, 1].
 * @param {unknown} value - candidate probability map.
 * @returns {Record<string, number> | undefined} the map, or undefined when unusable.
 */
function normalizeProbabilities(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const out = {};
	for (const [key, probability] of Object.entries(value)) {
		if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) return undefined;
		out[key] = probability;
	}
	return out;
}

/**
 * Render one state payload to the text/JSON form the API accepts.
 *
 * Non-text content is never sent: callers hand over already-extracted text.
 * @param {unknown} state - string, object, or array state.
 * @returns {{ state: unknown, truncated: boolean }} bounded state and whether trimming happened.
 */
function boundState(state) {
	const budget = MAX_STATE_CHARS;
	if (typeof state === "string") {
		return state.length <= budget ? { state, truncated: false } : { state: state.slice(0, budget), truncated: true };
	}
	let encoded;
	try {
		encoded = JSON.stringify(state);
	} catch {
		return { state: "", truncated: true };
	}
	if (encoded.length <= budget) return { state, truncated: false };
	return { state: encoded.slice(0, budget), truncated: true };
}

/**
 * Create the adapter. Nothing is resolved or opened until `evaluate` runs.
 * @param {object} options - `resolveKey`, optional `fetchImpl`, `endpoint`, `timeoutMs`, `onUsage`.
 * @returns {{ evaluate: Function, endpoint: string }} the adapter.
 */
function createTypeSafeClient(options) {
	const fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
	const endpoint = options.endpoint ?? ENDPOINT;
	const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 10000;

	/**
	 * One evaluation request: `{ state, model, questions }` in, typed answers out.
	 * @param {object} request - `state`, `model`, `questions`, optional `signal`.
	 * @returns {Promise<{ model: string, answers: object, usage: object }>} typed answers.
	 */
	async function evaluate(request) {
		const key = await options.resolveKey();
		if (typeof key !== "string" || key.length === 0) {
			throw new JevError("credential-missing", "Jev credential is not configured; enhancement falls back to the native path");
		}
		const questionIds = Object.keys(request.questions ?? {});
		if (questionIds.length === 0) throw new JevError("budget", "no questions to evaluate");
		if (questionIds.length > MAX_QUESTIONS_PER_CALL) {
			throw new JevError("budget", "question batch exceeds the plugin call budget");
		}
		const bounded = boundState(request.state);
		if (request.signal !== undefined && request.signal.aborted) {
			throw new JevError("cancelled", "Jev request cancelled");
		}
		const body = JSON.stringify({
			state: bounded.state,
			model: request.model,
			questions: request.questions
		});
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new JevError("timeout", "Jev request timed out")), timeoutMs);
		const onAbort = () => controller.abort(new JevError("cancelled", "Jev request cancelled"));
		if (request.signal !== undefined) {
			if (request.signal.aborted) onAbort();
			else request.signal.addEventListener("abort", onAbort, { once: true });
		}
		let response;
		try {
			response = await fetchImpl(endpoint, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: "Bearer " + key
				},
				body,
				signal: controller.signal
			});
		} catch (error) {
			if (error instanceof JevError) throw error;
			if (controller.signal.aborted) throw new JevError("timeout", "Jev request timed out", { cause: error });
			throw new JevError("transport", "Jev request failed to reach the service", { retryable: true, cause: error });
		} finally {
			clearTimeout(timer);
			if (request.signal !== undefined) request.signal.removeEventListener("abort", onAbort);
		}
		if (response.status < 200 || response.status >= 300) {
			const code = mapStatus(response.status);
			throw new JevError(code, "Jev service returned HTTP " + response.status, {
				status: response.status,
				retryable: code === "rate-limit" || code === "overloaded" || code === "unavailable"
			});
		}
		let payload;
		try {
			payload = await response.json();
		} catch (error) {
			throw new JevError("invalid-response", "Jev response body is not JSON", { cause: error });
		}
		const result = validateResponse(payload, request.questions);
		if (options.onUsage !== undefined) options.onUsage(result.usage, result.model);
		return result;
	}

	return { evaluate, endpoint };
}

export {
	ENDPOINT,
	ERROR_CODES,
	MAX_QUESTIONS_PER_CALL,
	MAX_STATE_CHARS,
	JevError,
	boundState,
	createTypeSafeClient,
	mapStatus,
	normalizeAnswer,
	normalizeProbabilities,
	validateResponse
};
