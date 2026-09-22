/**
 * DeepSeek-official engine: the Anthropic-compatible Messages API with the
 * native `web_search_20250305` server tool — the same wire route the shipped
 * `dsh-web-search-deepseek` provider uses (each search costs a model turn on
 * the DeepSeek account; the deepseek-official engine keeps that behavior
 * available behind the switcher). Structured `web_search_tool_result` blocks
 * only: URLs are never scraped out of model prose. Pure module (no
 * `@deepseek-ai/*` imports); transport and error factories arrive via `deps`.
 */
import { postJson, readJson, resolveApiKey, throwIfAborted } from "../http.js";

/** Anthropic-format model used for the search turn. */
export const DEEPSEEK_MODEL = "deepseek-v4-flash";

/** Default `anthropic-version` header value. */
export const DEEPSEEK_API_VERSION = "2023-06-01";

/** Upper bound on generated tokens for the Messages request. */
export const DEEPSEEK_MAX_TOKENS = 4096;

/** Attribution header sent on every request. */
const USER_AGENT = "deepseek-harness-dsh-web-search/0.1.0";

/**
 * Build the Messages request for one forced web search.
 * @param {{ baseURL: string, maxUses: number }} options - normalized DeepSeek options.
 * @param {string} query - the search query.
 * @returns {{ endpoint: string, body: Record<string, unknown> }} the request parts.
 */
export function buildDeepseekRequest(options, query) {
	return {
		endpoint: `${options.baseURL.replace(/\/+$/, "")}/messages`,
		body: {
			model: DEEPSEEK_MODEL,
			max_tokens: DEEPSEEK_MAX_TOKENS,
			messages: [{
				role: "user",
				content: [{ type: "text", text: `Perform a web search for the query: ${query}` }]
			}],
			tools: [{
				type: "web_search_20250305",
				name: "web_search",
				max_uses: options.maxUses
			}]
		}
	};
}

/** Build a `url → cited_text` map from every text block's citations[]. */
function citationSnippets(blocks) {
	const map = new Map();
	for (const block of blocks) {
		if (block?.type !== "text") continue;
		for (const cite of block.citations ?? []) {
			if (typeof cite?.url === "string" && cite.url.length > 0 && typeof cite.cited_text === "string" && cite.cited_text.length > 0 && !map.has(cite.url)) map.set(cite.url, cite.cited_text);
		}
	}
	return map;
}

/**
 * Map a Messages response to the seam's normalized result: walk
 * `web_search_tool_result` blocks, join each source to its citation excerpt,
 * dedupe by URL (`max_uses > 1` can surface one URL across searches).
 * @param {unknown} payload - the parsed response body.
 * @param {{ provider: (m: string, c?: string, cause?: unknown) => Error }} errors - error factory pair.
 * @returns {{ sources: Array<{ url: string, title?: string, snippet?: string, publishedAt?: string }>, truncated: boolean }} normalized result.
 */
export function mapDeepseekResponse(payload, errors) {
	if (payload === null || typeof payload !== "object") throw errors.provider("DeepSeek returned an unprocessable response body", "WEB_PROVIDER_ERROR");
	const blocks = /** @type {{ content?: unknown }} */ (payload).content;
	const list = Array.isArray(blocks) ? blocks : [];
	const resultBlocks = list.filter((block) => block?.type === "web_search_tool_result");
	if (resultBlocks.length === 0) throw errors.provider("DeepSeek returned no web_search_tool_result blocks; the request may not have triggered native web search", "WEB_PROVIDER_ERROR");
	const snippets = citationSnippets(list);
	const seen = new Set();
	const sources = [];
	for (const block of resultBlocks) {
		for (const item of block.content ?? []) {
			if (item?.type !== "web_search_result" || typeof item.url !== "string" || item.url.length === 0 || seen.has(item.url)) continue;
			seen.add(item.url);
			const snippet = snippets.get(item.url);
			sources.push({
				url: item.url,
				...typeof item.title === "string" && item.title.length > 0 ? { title: item.title } : {},
				...snippet !== undefined ? { snippet } : {},
				...typeof item.page_age === "string" && item.page_age.length > 0 ? { publishedAt: item.page_age } : {}
			});
		}
	}
	return { sources, truncated: false };
}

/**
 * Run one DeepSeek-official search.
 * @param {{ apiKey?: string, resolveKey?: () => Promise<string | undefined>, baseURL: string, maxUses: number }} options - normalized DeepSeek options.
 * @param {{ query: string, maxResults?: number }} request - the seam's search request.
 * @param {AbortSignal | undefined} signal - cancellation signal.
 * @param {{ fetch: typeof fetch, errors: { provider: (m: string, c?: string, cause?: unknown) => Error, aborted: (cause?: unknown) => Error } }} deps - transport and error deps.
 * @returns {Promise<{ sources: Array<{ url: string, title?: string, snippet?: string, publishedAt?: string }>, truncated: boolean }>} the normalized result.
 */
export async function searchDeepseek(options, request, signal, deps) {
	const { errors } = deps;
	const apiKey = await resolveApiKey(options, signal, errors);
	if (apiKey === undefined || apiKey.length === 0) {
		throw errors.provider(`DeepSeek search has no API key; store one through Settings > Plugins > Plugin configuration > Web search (enter the key and save), export it as DEEPSEEK_API_KEY in the launching environment, or set a literal "deepseekApiKey" in the web-search config`, "WEB_PROVIDER_CREDENTIAL_MISSING");
	}
	const { endpoint, body } = buildDeepseekRequest(options, request.query);
	throwIfAborted(signal, errors);
	options.recordRequest?.({ endpoint, apiVersion: DEEPSEEK_API_VERSION, body });
	const response = await postJson(endpoint, {
		headers: {
			"x-api-key": apiKey,
			"authorization": `Bearer ${apiKey}`,
			"anthropic-version": DEEPSEEK_API_VERSION,
			"content-type": "application/json",
			"accept": "application/json",
			"user-agent": USER_AGENT
		},
		body,
		...signal !== undefined ? { signal } : {}
	}, deps);
	if (!response.ok) {
		let detail = "";
		try {
			const payload = await readJson(response, signal, errors);
			const parsed = /** @type {{ error?: unknown, message?: unknown }} */ (payload);
			const text = typeof parsed.error === "string" ? parsed.error : /** @type {{ message?: unknown }} */ (parsed.error)?.message ?? parsed.message;
			if (text !== undefined && String(text).length > 0) detail = `: ${String(text)}`;
		} catch {
			/* status-only message below */
		}
		throw errors.provider(`DeepSeek API error (HTTP ${response.status})${detail}\n\nThe web search request used endpoint ${JSON.stringify(endpoint)}. Search endpoint configuration is separate from chat; change it under Settings > Plugins > Plugin configuration > Web search (Endpoint field) or set "deepseekBaseUrl" in the web-search config. Only the user should choose or change the endpoint.`, "WEB_PROVIDER_ERROR");
	}
	return mapDeepseekResponse(await readJson(response, signal, errors), errors);
}
