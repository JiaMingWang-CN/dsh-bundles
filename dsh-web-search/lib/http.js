/**
 * Transport helpers shared by the search engines: JSON POSTs with strict
 * cancellation classification (caller abort is `WEB_ABORTED`, everything else
 * after dispatch is `WEB_PROVIDER_ERROR`) and no redirect following.
 */

/**
 * Throw the stable cancellation error when the caller already aborted.
 * @param {AbortSignal | undefined} signal - the caller's cancellation signal.
 * @param {{ aborted: (cause?: unknown) => Error }} errors - error factory pair.
 */
export function throwIfAborted(signal, errors) {
	if (signal?.aborted === true) throw errors.aborted(signal.reason);
}

/**
 * Resolve an operation's API key while racing asynchronous credential lookup
 * against caller cancellation. Resolver failures keep the web error contract.
 * @param {{ apiKey?: string, resolveKey?: () => Promise<string | undefined> }} options - key sources.
 * @param {AbortSignal | undefined} signal - caller cancellation signal.
 * @param {{ provider: (m: string, c?: string, cause?: unknown) => Error, aborted: (cause?: unknown) => Error }} errors - error factories.
 * @returns {Promise<string | undefined>} the resolved key.
 */
export async function resolveApiKey(options, signal, errors) {
	throwIfAborted(signal, errors);
	if ((options.apiKey?.length ?? 0) > 0) return options.apiKey;
	if (options.resolveKey === undefined) return undefined;
	const operation = Promise.resolve().then(() => options.resolveKey());
	try {
		if (signal === undefined) return await operation;
		return await new Promise((resolve, reject) => {
			const onAbort = () => reject(errors.aborted(signal.reason));
			signal.addEventListener("abort", onAbort, { once: true });
			operation.then((value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			}, (error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			});
		});
	} catch (error) {
		if (signal?.aborted === true || isAbortError(error) || /** @type {{ code?: unknown }} */ (error)?.code === "WEB_ABORTED") {
			throw /** @type {Error} */ (/** @type {unknown} */ (error));
		}
		throw errors.provider(`web search credential resolution failed: ${String(error)}`, "WEB_PROVIDER_ERROR", error);
	}
}

/**
 * True for a fetch/`AbortSignal` abort.
 * @param {unknown} error - the thrown value.
 * @returns {boolean} whether the failure is an abort.
 */
export function isAbortError(error) {
	return error !== null && typeof error === "object" && /** @type {{ name?: unknown }} */ (error).name === "AbortError";
}

/**
 * POST one JSON body and return the raw response. Non-2xx responses are
 * returned (not thrown): each engine maps its own status codes to guidance.
 * @param {string} url - the endpoint.
 * @param {{ headers: Record<string, string>, body: unknown, signal?: AbortSignal }} request - request parts.
 * @param {{ fetch: typeof fetch, errors: { provider: (m: string, c?: string, cause?: unknown) => Error, aborted: (cause?: unknown) => Error } }} deps - transport and error deps.
 * @returns {Promise<Response>} the raw response.
 */
export async function postJson(url, request, deps) {
	const { fetch, errors } = deps;
	throwIfAborted(request.signal, errors);
	try {
		return await fetch(url, {
			method: "POST",
			redirect: "error",
			headers: request.headers,
			body: JSON.stringify(request.body),
			...(request.signal !== undefined ? { signal: request.signal } : {})
		});
	} catch (error) {
		if (request.signal?.aborted === true || isAbortError(error)) throw errors.aborted(request.signal?.aborted === true ? request.signal.reason : error);
		throw errors.provider(`web search request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", error);
	}
}

/**
 * Parse a response body as JSON, classifying aborts and parse failures.
 * @param {Response} response - the raw response.
 * @param {AbortSignal | undefined} signal - the caller's cancellation signal.
 * @param {{ provider: (m: string, c?: string, cause?: unknown) => Error, aborted: (cause?: unknown) => Error }} errors - error factory pair.
 * @returns {Promise<unknown>} the parsed payload.
 */
export async function readJson(response, signal, errors) {
	throwIfAborted(signal, errors);
	try {
		return await response.json();
	} catch (error) {
		if (signal?.aborted === true || isAbortError(error)) throw errors.aborted(signal?.aborted === true ? signal.reason : error);
		throw errors.provider(`web search returned an unprocessable response body: ${String(error)}`, "WEB_PROVIDER_ERROR", error);
	}
}
