/**
 * Model-native web search engine: one minimal chat completion carrying the
 * model API's server-side `web_search` tool (MiMo / openai-compatible), with
 * structured citation extraction only — never URLs scraped out of model prose.
 *
 * Billing is per search round at the provider (MiMo: ¥16 per 1000 plugin
 * calls plus token fees), so the request pins `max_keyword: 1` to cap cost.
 * Pure module (no `@deepseek-ai/*` imports); transport and error factories
 * arrive via `deps`.
 */
import { postJson, readJson, resolveApiKey } from "../http.js";

/** Tokens reserved for the model's summary over the retrieved sources. */
const MAX_COMPLETION_TOKENS = 1024;

/**
 * Build the chat-completions request for one forced web search.
 * @param {{ modelId: string }} options - normalized model-native options.
 * @param {string} query - the search query.
 * @param {number | undefined} maxResults - the seam's source cap.
 * @returns {Record<string, unknown>} the request body.
 */
export function buildModelRequest(options, query, maxResults) {
	return {
		model: options.modelId,
		messages: [{ role: "user", content: query }],
		max_completion_tokens: MAX_COMPLETION_TOKENS,
		stream: false,
		thinking: { type: "disabled" },
		tools: [{
			type: "web_search",
			max_keyword: 1,
			force_search: true,
			...(maxResults !== undefined ? { limit: maxResults } : {})
		}]
	};
}

/** Collect one candidate citation object into a normalized source. */
function pushSource(out, seen, item) {
	if (item === null || typeof item !== "object") return;
	const candidate = /** @type {{ url?: unknown, link?: unknown, title?: unknown, name?: unknown, snippet?: unknown, content?: unknown, description?: unknown, cited_text?: unknown, publishedAt?: unknown, date?: unknown, page_age?: unknown, url_citation?: unknown }} */ (item);
	const nested = candidate.url_citation !== null && typeof candidate.url_citation === "object" ? /** @type {Record<string, unknown>} */ (candidate.url_citation) : undefined;
	const record = nested ?? candidate;
	const url = typeof record.url === "string" ? record.url : typeof record.link === "string" ? record.link : undefined;
	if (url === undefined || url.length === 0 || seen.has(url)) return;
	seen.add(url);
	const title = typeof record.title === "string" ? record.title : typeof record.name === "string" ? record.name : undefined;
	const snippet = typeof record.snippet === "string" ? record.snippet : typeof record.content === "string" ? record.content : typeof record.description === "string" ? record.description : typeof record.cited_text === "string" ? record.cited_text : undefined;
	const publishedAt = record.publishedAt ?? record.date ?? record.page_age;
	out.push({
		url,
		...title !== undefined && title.length > 0 ? { title } : {},
		...snippet !== undefined && snippet.length > 0 ? { snippet } : {},
		...publishedAt != null && String(publishedAt).length > 0 ? { publishedAt: String(publishedAt) } : {}
	});
}

/** Walk the known structured citation sites of a chat-completions response. */
function collectSources(payload) {
	const out = [];
	const seen = new Set();
	const body = /** @type {Record<string, unknown>} */ (payload);
	const messages = [body, ...(Array.isArray(body.choices) ? body.choices.map((choice) => /** @type {{ message?: unknown }} */ (choice)?.message).filter((message) => message !== null && typeof message === "object") : [])];
	for (const message of messages) {
		const record = /** @type {Record<string, unknown>} */ (message);
		for (const key of ["annotations", "citations", "search_results", "web_search_results", "url_citation"]) {
			const value = record[key];
			if (Array.isArray(value)) for (const item of value) pushSource(out, seen, item);
			else if (value !== null && typeof value === "object") pushSource(out, seen, value);
		}
	}
	for (const key of ["search_results", "web_search_results"]) {
		const value = body[key];
		if (Array.isArray(value)) for (const item of value) pushSource(out, seen, item);
	}
	return out;
}

/**
 * Map a chat-completions response to the seam's normalized result.
 * @param {unknown} payload - the parsed response body.
 * @param {{ provider: (m: string, c?: string, cause?: unknown) => Error }} errors - error factory pair.
 * @returns {{ content?: string, sources: Array<{ url: string, title?: string, snippet?: string, publishedAt?: string }>, truncated: boolean }} normalized result.
 */
export function mapModelResponse(payload, errors) {
	if (payload === null || typeof payload !== "object") throw errors.provider("the model API returned an unprocessable response body", "WEB_PROVIDER_ERROR");
	const body = /** @type {{ choices?: Array<{ message?: { content?: unknown } }>, error?: unknown, message?: { content?: unknown } }} */ (payload);
	const message = body.choices?.[0]?.message ?? body.message;
	const content = typeof message?.content === "string" && message.content.length > 0 ? message.content : undefined;
	const sources = collectSources(payload);
	if (sources.length === 0) {
		throw errors.provider(`the model API returned no structured search citations (top-level keys: ${Object.keys(payload).join(", ") || "none"}); the web search plugin may be disabled for this API key or the response shape is unrecognized`, "WEB_PROVIDER_ERROR");
	}
	return { ...content !== undefined ? { content } : {}, sources, truncated: false };
}

/**
 * Run one model-native web search.
 * @param {{ apiKey?: string, resolveKey?: () => Promise<string | undefined>, baseURL: string, modelId: string }} options - normalized model-native options.
 * @param {{ query: string, maxResults?: number }} request - the seam's search request.
 * @param {AbortSignal | undefined} signal - cancellation signal.
 * @param {{ fetch: typeof fetch, errors: { provider: (m: string, c?: string, cause?: unknown) => Error, aborted: (cause?: unknown) => Error } }} deps - transport and error deps.
 * @returns {Promise<{ content?: string, sources: Array<{ url: string, title?: string, snippet?: string, publishedAt?: string }>, truncated: boolean }>} the normalized result.
 */
export async function searchModel(options, request, signal, deps) {
	const { errors } = deps;
	const apiKey = await resolveApiKey(options, signal, errors);
	if (apiKey === undefined || apiKey.length === 0) {
		throw errors.provider(`model-native web search has no API key; store one through Settings > Plugins > Plugin configuration > Web search (enter the key and save), export it as MIMO1_API_KEY in the launching environment, or set a literal "modelApiKey" in the web-search config`, "WEB_PROVIDER_CREDENTIAL_MISSING");
	}
	const endpoint = `${options.baseURL.replace(/\/+$/, "")}/chat/completions`;
	const response = await postJson(endpoint, {
		headers: {
			"authorization": `Bearer ${apiKey}`,
			"api-key": apiKey,
			"content-type": "application/json",
			"accept": "application/json"
		},
		body: buildModelRequest(options, request.query, request.maxResults),
		...signal !== undefined ? { signal } : {}
	}, deps);
	if (!response.ok) {
		let detail = "";
		try {
			const payload = await readJson(response, signal, errors);
			const message = /** @type {{ error?: { message?: unknown, param?: unknown } | string, message?: unknown }} */ (payload)?.error;
			const text = typeof message === "string" ? message : typeof message?.param === "string" ? message.param : typeof message?.message === "string" ? message.message : typeof /** @type {{ message?: unknown }} */ (payload)?.message === "string" ? /** @type {{ message: string }} */ (payload).message : undefined;
			if (text !== undefined && text.length > 0) detail = `: ${text}`;
		} catch {
			/* status-only message below */
		}
		if (/webSearchEnabled/i.test(detail)) {
			detail += ". Activate the Web Search plugin in the model provider's console (Console > Plugin Management) first; it bills per search round";
		}
		if (response.status === 401 || response.status === 403) {
			throw errors.provider(`the model API rejected the API key or the web search plugin is not activated (HTTP ${response.status})${detail}; activate the Web Search plugin in the provider console and check the key`, "WEB_PROVIDER_CREDENTIAL_MISSING");
		}
		throw errors.provider(`the model API error (HTTP ${response.status})${detail}`, "WEB_PROVIDER_ERROR");
	}
	return mapModelResponse(await readJson(response, signal, errors), errors);
}
