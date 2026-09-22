/**
 * The switchable multi-engine `WebSearchProvider` registered into `ctx.web` as
 * `web-search`. Engine selection is re-read from the live settings source at
 * every search entry (one snapshot per call, so a mid-flight engine switch
 * never mixes two configurations). Pure module (no `@deepseek-ai/*` imports);
 * the Host half injects the seam's real `WebError` factories via `deps`.
 */
import { engineAvailable } from "./options.js";

/** Stable provider id, pinned by the `web` row's `searchProvider`. */
export const WEB_SEARCH_PROVIDER_ID = "web-search";

/**
 * A search provider that dispatches to the settings-selected engine.
 */
export class DispatchProvider {
	/**
	 * @param {() => { engine: string, tavily: object, model: object, deepseek: object }} resolveOptions - live options source.
	 * @param {Record<string, (options: object, request: { query: string, maxResults?: number }, signal: AbortSignal | undefined, deps: object) => Promise<object>>} engines - engine runners by id.
	 * @param {{ fetch: typeof fetch, errors: { provider: (m: string, c?: string, cause?: unknown) => Error, aborted: (cause?: unknown) => Error } }} deps - transport and error deps.
	 */
	constructor(resolveOptions, engines, deps) {
		this.resolveOptions = resolveOptions;
		this.engines = engines;
		this.deps = deps;
	}

	/** Stable id this provider registers under. */
	id = WEB_SEARCH_PROVIDER_ID;

	/** Cheap local usability check for the currently selected engine. */
	available() {
		const options = this.resolveOptions();
		return engineAvailable(options.engine, options);
	}

	/**
	 * Run one search through the selected engine.
	 * @param {{ query: string, maxResults?: number }} request - the seam's search request.
	 * @param {AbortSignal | undefined} [signal] - cancellation signal forwarded to the engine.
	 * @returns {Promise<object>} the normalized result.
	 */
	async search(request, signal) {
		const options = this.resolveOptions();
		const engine = options.engine;
		const run = this.engines[engine];
		if (run === undefined) throw this.deps.errors.provider(`unknown web search engine "${engine}"`, "WEB_PROVIDER_ERROR");
		return run(options[engine] ?? options, request, signal, this.deps);
	}
}
