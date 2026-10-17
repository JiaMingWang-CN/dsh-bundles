/**
 * Settings-section normalization and per-engine usability checks.
 *
 * Pure module (no `@deepseek-ai/*` imports) so `node --test` can run it
 * standalone. The Host half supplies credential resolvers; a resolver's
 * presence is what lets `available()` stay synchronous and network-free while
 * still permitting an operation-time `WEB_PROVIDER_CREDENTIAL_MISSING`.
 *
 * The deprecated `engine: "deepseek"` value (from the 0.3.x official engine)
 * normalizes to Tavily instead of failing the whole plugin: the settings schema
 * still accepts it so the plugin keeps loading and the master switch stays
 * reachable.
 */

/** Engine ids offered by the settings card, in display order. */
export const ENGINES = ["tavily", "model"];

/** Schema defaults, mirrored here so normalization also holds outside the seam. */
export const DEFAULTS = {
	engine: "tavily",
	tavilySearchDepth: "basic",
	modelBaseUrl: "https://api.xiaomimimo.com/v1",
	modelId: "mimo-v2.6-flash"
};

/** Optional-secret field pairs: literal key first, resolver as the fallback. */
function keySource(section, literal, resolveKey) {
	const apiKey = typeof section?.[literal] === "string" && section[literal].length > 0 ? section[literal] : undefined;
	return { ...apiKey !== undefined ? { apiKey } : {}, resolveKey };
}

/**
 * Normalize one resolved settings section into per-engine options.
 * @param {Record<string, unknown>} [section] - the resolved `web-search` section.
 * @param {{ tavily?: () => Promise<string | undefined>, model?: () => Promise<string | undefined> }} [resolveKeys] - credential resolvers.
 * @returns {{ engine: string, tavily: object, model: object }} normalized options.
 */
export function normalizeSection(section = {}, resolveKeys = {}) {
	const engine = ENGINES.includes(/** @type {string} */ (section?.engine)) ? /** @type {string} */ (section.engine) : DEFAULTS.engine;
	return {
		engine,
		tavily: {
			...keySource(section, "tavilyApiKey", resolveKeys.tavily),
			searchDepth: section?.tavilySearchDepth === "advanced" ? "advanced" : DEFAULTS.tavilySearchDepth
		},
		model: {
			...keySource(section, "modelApiKey", resolveKeys.model),
			baseURL: typeof section?.modelBaseUrl === "string" && section.modelBaseUrl.length > 0 ? /** @type {string} */ (section.modelBaseUrl) : DEFAULTS.modelBaseUrl,
			modelId: typeof section?.modelId === "string" && section.modelId.length > 0 ? /** @type {string} */ (section.modelId) : DEFAULTS.modelId
		}
	};
}

/** Whether an engine has any key source (literal or resolver) — sync, no I/O. */
function hasKeySource(options) {
	return (options.apiKey?.length ?? 0) > 0 || typeof options.resolveKey === "function";
}

/**
 * Cheap local usability check for one engine (the seam's `available()`
 * semantics): synchronous, no network calls.
 * @param {string} engine - the engine id under test.
 * @param {{ tavily: object, model: object }} options - normalized options.
 * @returns {boolean} whether the engine can be selected right now.
 */
export function engineAvailable(engine, options) {
	switch (engine) {
		case "tavily":
			return hasKeySource(options.tavily);
		case "model":
			return hasKeySource(options.model) && URL.canParse(options.model.baseURL) && options.model.modelId.length > 0;
		default:
			return false;
	}
}
