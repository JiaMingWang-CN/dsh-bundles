/**
 * Provider-neutral error vocabulary shared by the engine modules.
 *
 * Every engine receives this factory through its dependency seam. It creates
 * the real `WebError` exported by `@deepseek-ai/dsh-web`, preserving the
 * `HarnessError` prototype used by the tool runtime for structured metadata.
 */

import { WebError } from "@deepseek-ai/dsh-web";

/**
 * Build a coded web failure with the seam's real `WebError` type.
 * @param {string} message - human-readable failure text.
 * @param {string} [code] - machine-routable code; defaults to provider failure.
 * @param {unknown} [cause] - optional underlying failure.
 * @returns {WebError} the coded error.
 */
function provider(message, code = "WEB_PROVIDER_ERROR", cause = undefined) {
	return new WebError(message, code, cause === undefined ? undefined : { cause });
}

/**
 * Build the stable cancellation error (`WEB_ABORTED`), retaining the reason.
 * @param {unknown} [cause] - the caller's abort reason, when any.
 * @returns {Error} the coded error.
 */
function aborted(cause = undefined) {
	return provider("web search aborted", "WEB_ABORTED", cause);
}

/** Web-error factory pair injected into every engine. */
export const webErrors = { provider, aborted };

/** Backward-compatible alias retained for pure engine consumers. */
export const plainErrors = webErrors;
