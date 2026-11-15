/**
 * Context7 OAuth device-flow helpers (RFC 8628), mirroring `ctx7 login`.
 *
 * Context7's CLI (`npx ctx7 setup` / `ctx7 login`) signs in with this flow and
 * ends up holding a long-lived API key (`ctx7sk-…`) that it stores and later
 * sends as `Authorization: Bearer <key>` / `CONTEXT7_API_KEY`. DSH's
 * `dsh-mcp-client` does not implement OAuth itself, so this module talks to the
 * same public endpoints to obtain the key, which the host plugin then stores in
 * the DSH credential store.
 *
 * Endpoints and the CLI client id are taken from the upstream `ctx7` CLI source
 * (packages/cli/src/utils/auth.ts and constants.ts). `fetchImpl` is injectable
 * so the state machine can be exercised without the network.
 *
 * @module @wjm200509/dsh-bundle-mcp-toolkit/oauth
 */

/** Context7 base URL; all OAuth endpoints hang off it. */
export const DEFAULT_BASE_URL = 'https://context7.com'

/** Public OAuth client id used by the official `ctx7` CLI. */
export const CLI_CLIENT_ID = '2veBSofhicRBguUT'

/** RFC 8628 device-code grant type. */
const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

/** RFC 8628 default poll interval when the server omits `interval`. */
const DEFAULT_POLL_INTERVAL_SECONDS = 5

/** Default absolute timeout for one OAuth HTTP request. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/**
 * POST a form-encoded OAuth request and return the raw Response.
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {URLSearchParams} params
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
async function postForm(fetchImpl, url, params, timeoutMs) {
  /** @type {AbortSignal | undefined} */
  let signal
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    signal = AbortSignal.timeout(timeoutMs)
  }
  return fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
    ...(signal !== undefined ? { signal } : {}),
  })
}

/**
 * Begin a device authorization (RFC 8628 §3.1/§3.2).
 *
 * @param {object} [options]
 * @param {string} [options.baseUrl] Context7 base URL.
 * @param {string} [options.clientId] OAuth client id.
 * @param {string} [options.hostname] Best-effort device hostname shown on the approval page.
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{
 *   deviceCode: string,
 *   userCode: string,
 *   verificationUri: string,
 *   verificationUriComplete: string | undefined,
 *   expiresIn: number,
 *   interval: number,
 * }>}
 */
export async function startDeviceAuthorization(options = {}) {
  const {
    baseUrl = DEFAULT_BASE_URL,
    clientId = CLI_CLIENT_ID,
    hostname,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = options

  const params = new URLSearchParams({ client_id: clientId })
  if (hostname) params.set('hostname', hostname)

  const response = await postForm(fetchImpl, `${baseUrl}/api/oauth/device/code`, params, timeoutMs)
  if (!response.ok) {
    const detail = await safeText(response)
    throw new Error(
      `Context7 device authorization failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
    )
  }
  const data = await response.json()

  if (!data || typeof data.device_code !== 'string' || typeof data.user_code !== 'string'
    || typeof data.verification_uri !== 'string') {
    throw new Error('Context7 device authorization returned an unexpected response')
  }

  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    verificationUriComplete: typeof data.verification_uri_complete === 'string'
      ? data.verification_uri_complete
      : undefined,
    expiresIn: Number.isFinite(data.expires_in) ? data.expires_in : 600,
    interval: Number.isFinite(data.interval) ? data.interval : DEFAULT_POLL_INTERVAL_SECONDS,
  }
}

/**
 * Poll the device token endpoint once (RFC 8628 §3.4/§3.5).
 *
 * Resolves to a discriminated result instead of throwing for the expected
 * pending/slow_down/denied/expired/transient states, so the caller owns the
 * loop and its backoff.
 *
 * @param {object} options
 * @param {string} options.deviceCode
 * @param {string} [options.baseUrl]
 * @param {string} [options.clientId]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<
 *   | { status: 'approved', accessToken: string }
 *   | { status: 'pending' | 'slow_down' | 'denied' | 'expired' | 'transient', errorMessage?: string }
 * >}
 */
export async function pollDeviceToken(options) {
  const {
    deviceCode,
    baseUrl = DEFAULT_BASE_URL,
    clientId = CLI_CLIENT_ID,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = options

  const params = new URLSearchParams({
    grant_type: DEVICE_CODE_GRANT,
    device_code: deviceCode,
    client_id: clientId,
  })

  let response
  try {
    response = await postForm(fetchImpl, `${baseUrl}/api/oauth/device/token`, params, timeoutMs)
  } catch (error) {
    // A network blip must not end the login; keep polling.
    return { status: 'transient', errorMessage: error instanceof Error ? error.message : 'network error' }
  }

  if (response.ok) {
    const tokens = await response.json()
    if (!tokens || typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
      throw new Error('Context7 device token response carried no access token')
    }
    return { status: 'approved', accessToken: tokens.access_token }
  }

  if (response.status >= 500) {
    return { status: 'transient', errorMessage: `HTTP ${response.status}` }
  }

  /** @type {{ error?: string, error_description?: string }} */
  let body = {}
  try {
    body = await response.json()
  } catch {
    // An interceptor's HTML, not an OAuth error object.
  }

  switch (body.error) {
    case 'authorization_pending':
      return { status: 'pending' }
    case 'slow_down':
      return { status: 'slow_down' }
    case 'access_denied':
      return { status: 'denied' }
    case 'expired_token':
      return { status: 'expired' }
    default:
      throw new Error(body.error_description || body.error || `HTTP ${response.status}`)
  }
}

/**
 * Read a bounded excerpt of a failed response body.
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function safeText(response) {
  try {
    return (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 200)
  } catch {
    return ''
  }
}
