/**
 * The Context7 MCP server row, mounted by the bundle's Host plugin instead of
 * the bundle's static patch.
 *
 * Why it is not a static row: `dsh-mcp-client` refuses to load a row whose
 * transport strings contain a `${credential:…}` template unless a credentials
 * provider is already *active* — its load-time check is
 * `ctx.get('credentials') === undefined`, and cordis's `ctx.get` is strict, so a
 * provider that has merely been provided (still running its asynchronous
 * `Service.init`) reads as absent. A static row starts together with every other
 * loader entry, i.e. inside exactly that window, and `dsh-credentials-local`
 * finishes its init asynchronously (reads, validates and might migrate
 * `.credentials.yaml`, then starts a chokidar watcher). The row therefore fails
 * to load on every Host start and never retries, because a failed activation is
 * not a connection failure.
 *
 * Mounting it from the plugin — whose `inject` already waits for `credentials` —
 * is what makes the credential template safe: by the time `apply` runs, the
 * provider is active. The row keeps the client's own behaviour afterwards
 * (waiting-credentials while no key exists, reconnect on a credential update).
 *
 * @module @wjm200509/dsh-bundle-mcp-toolkit/context7-mcp
 */

/** Credential reference the Context7 row reads. */
export const API_KEY_REF = 'CONTEXT7_API_KEY'

/**
 * Context7 row configuration, identical to what the removed patch row carried:
 * stdio transport, a pinned Context7 version, and the API key read from the DSH
 * credential store at connect time.
 */
export const CONTEXT7_MCP_CONFIG = Object.freeze({
  transport: 'stdio',
  serverName: 'context7',
  command: 'npx',
  args: ['-y', '@upstash/context7-mcp@4.5.0'],
  expandTemplates: true,
  env: { CONTEXT7_API_KEY: '${credential:CONTEXT7_API_KEY}' },
})

/**
 * Mount the Context7 MCP client under the calling plugin's fiber.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context; its
 * `inject` must already have waited for an active `credentials` provider.
 * @param {any} mcpClient - the `@deepseek-ai/dsh-mcp-client` plugin namespace.
 * @returns {() => Promise<void>} disposer that unmounts the client.
 */
export function mountContext7(ctx, mcpClient) {
  const handle = ctx.plugin(mcpClient, CONTEXT7_MCP_CONFIG)
  // The client reports connection problems through its status cell and its own
  // diagnostics; only an activation failure surfaces here (a duplicate
  // `serverName`, for instance), and it must not become an unhandled rejection.
  handle.await().catch((error) => {
    console.warn(
      `[context7-auth] Context7 MCP 客户端未能激活：${error instanceof Error ? error.message : String(error)}`,
    )
  })
  return () => handle.dispose()
}
