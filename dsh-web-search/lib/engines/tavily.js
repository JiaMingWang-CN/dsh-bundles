/**
 * Tavily search engine (`https://api.tavily.com/search`, free tier: 1000
 * credits/month). Pure module (no `@deepseek-ai/*` imports) so `node --test`
 * can run it standalone; transport and error factories arrive via `deps`.
 */
import { postJson, readJson, resolveApiKey } from "../http.js";

/** The Tavily Search endpoint. */
export const TAVILY_ENDPOINT = "https://api.tavily.com/search";

/**
 * Map a Tavily Search response to the seam's normalized result.
 * `answer` becomes `content`, each result becomes one citeable source
 * (`content` → `snippet`, `published_date` → `publishedAt`).
 * @param {unknown} payload - the parsed response body.
 * @param {{ provider: (m: string, c?: string, cause?: unknown) => Error }} errors - error factory pair.
 * @returns {{ content?: string, sources: Array<{ url: string, title?: string, snippet?: string, publishedAt?: string }>, truncated: boolean }} normalized result.
 */
export function mapTavilyResponse(payload, errors) {
	if (payload === null || typeof payload !== "object") throw errors.provider("Tavily returned an unprocessable response body", "WEB_PROVIDER_ERROR");
	const body = /** @type {{ answer?: unknown, results?: unknown }} */ (payload);
	const results = Array.isArray(body.results) ? body.results : undefined;
	const answer = typeof body.answer === "string" && body.answer.length > 0 ? body.answer : undefined;
	if (results === undefined && answer === undefined) throw errors.provider(`Tavily returned no recognizable search results (top-level keys: ${Object.keys(body).join(", ") || "none"})`, "WEB_PROVIDER_ERROR");
	const sources = [];
	for (const item of results ?? []) {
		if (item === null || typeof item !== "object") continue;
		const result = /** @type {{ url?: unknown, title?: unknown, content?: unknown, published_date?: unknown }} */ (item);
		if (typeof result.url !== "string" || result.url.length === 0) continue;
		sources.push({
			url: result.url,
			...(typeof result.title === "string" && result.title.length > 0 ? { title: result.title } : {}),
			...(typeof result.content === "string" && result.content.length > 0 ? { snippet: result.content } : {}),
			...(result.published_date != null && String(result.published_date).length > 0 ? { publishedAt: String(result.published_date) } : {})
		});
	}
	return { ...answer !== undefined ? { content: answer } : {}, sources, truncated: false };
}

/**
 * Run one Tavily search.
 * @param {{ apiKey?: string, resolveKey?: () => Promise<string | undefined>, searchDepth: string }} options - normalized Tavily options.
 * @param {{ query: string, maxResults?: number }} request - the seam's search request.
 * @param {AbortSignal | undefined} signal - cancellation signal.
 * @param {{ fetch: typeof fetch, errors: { provider: (m: string, c?: string, cause?: unknown) => Error, aborted: (cause?: unknown) => Error } }} deps - transport and error deps.
 * @returns {Promise<{ content?: string, sources: Array<{ url: string, title?: string, snippet?: string, publishedAt?: string }>, truncated: boolean }>} the normalized result.
 */
export async function searchTavily(options, request, signal, deps) {
	const { errors } = deps;
	const apiKey = await resolveApiKey(options, signal, errors);
	if (apiKey === undefined || apiKey.length === 0) {
		throw errors.provider(`Tavily search has no API key; store one through Settings > Plugins > Plugin configuration > Web search (enter the key and save), export it as TAVILY_API_KEY in the launching environment, or set a literal "tavilyApiKey" in the web-search config`, "WEB_PROVIDER_CREDENTIAL_MISSING");
	}
	const response = await postJson(TAVILY_ENDPOINT, {
		headers: {
			"authorization": `Bearer ${apiKey}`,
			"content-type": "application/json",
			"accept": "application/json"
		},
		body: {
			query: request.query,
			search_depth: options.searchDepth === "advanced" ? "advanced" : "basic",
			include_answer: true,
			...(request.maxResults !== undefined ? { max_results: request.maxResults } : {})
		},
		...signal !== undefined ? { signal } : {}
	}, deps);
	if (!response.ok) throw await statusError(response, signal, errors);
	return mapTavilyResponse(await readJson(response, signal, errors), errors);
}

/**
 * Map a non-2xx Tavily status to actionable guidance.
 * @param {Response} response - the raw response.
 * @param {AbortSignal | undefined} signal - cancellation signal.
 * @param {{ provider: (m: string, c?: string, cause?: unknown) => Error, aborted: (cause?: unknown) => Error }} errors - error factory pair.
 * @returns {Promise<Error>} the coded error to throw.
 */
async function statusError(response, signal, errors) {
	let detail = "";
	try {
		const payload = await readJson(response, signal, errors);
		const message = /** @type {{ detail?: { error?: unknown } }} */ (payload)?.detail?.error;
		if (typeof message === "string" && message.length > 0) detail = `: ${message}`;
	} catch {
		/* status-only message below */
	}
	if (response.status === 401 || response.status === 403) {
		return errors.provider(`Tavily rejected the API key (HTTP ${response.status})${detail}`, "WEB_PROVIDER_CREDENTIAL_MISSING");
	}
	if (response.status === 429 || response.status === 432) {
		return errors.provider(`Tavily rate limit or plan quota reached (HTTP ${response.status})${detail}. The free tier allows 1000 credits per month; switch the web search engine in Settings > Plugins > Plugin configuration > Web search when exhausted`, "WEB_PROVIDER_ERROR");
	}
	return errors.provider(`Tavily API error (HTTP ${response.status})${detail}`, "WEB_PROVIDER_ERROR");
}
