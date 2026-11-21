/**
 * dsh-bundle-mcp-toolkit — Context7 sign-in host half.
 *
 * Context7 runs in API-key mode: its MCP client row reads `CONTEXT7_API_KEY`
 * from the DSH credential store via `${credential:CONTEXT7_API_KEY}`. Nothing in
 * the configuration ever holds the key, and until a key exists the row simply
 * waits for credentials.
 *
 * That row is mounted from here rather than configured in `patch.yml`; see
 * ./context7-mcp.js for why a static row cannot load this template.
 *
 * This plugin closes the loop so the experience matches the official
 * `npx ctx7 setup`: on first use it starts Context7's OAuth device flow, hands
 * the user the verification link and one-time code through the `context7_login`
 * tool, polls until approval, and then stores the issued API key with
 * `ctx.credentials.set`. Storing the key fires the credential-update event the
 * MCP client listens on, so the mounted row reconnects and starts serving tools
 * — without editing any configuration file.
 *
 * While no key is configured a short system-prompt note tells the model to call
 * `context7_login` and pass the link to the user, so a fresh install signs in on
 * the first request that needs Context7.
 *
 * @module @wjm200509/dsh-bundle-mcp-toolkit
 */

import { hostname } from 'node:os'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { startDeviceAuthorization, pollDeviceToken } from './oauth.js'
import { readCtx7ApiKey } from './ctx7-store.js'
import { API_KEY_REF, mountContext7 } from './context7-mcp.js'

/** Stable Cordis plugin name. */
export const name = 'context7-auth'

/** Host services this plugin needs. */
export const inject = ['tools', 'credentials', 'systemPrompt']

/** Poll backoff added on `slow_down` / transient failures, in milliseconds. */
const BACKOFF_MS = 5_000

/** Prompt-section placement: just after the MCP server instructions. */
const SECTION_ORDER = 3150

/** System-prompt note shown only while Context7 has no API key. */
const LOGIN_NOTE = [
  'Context7 尚未登录：它的 MCP 工具要等登录后才可用。',
  '当需要 Context7 的库文档时，先调用 context7_login 工具，把返回的验证链接和一次性验证码原样交给用户；',
  '用户在浏览器批准后 API Key 会自动保存，然后即可重试。',
].join('')

/**
 * Sleep helper that records its timer so disposal can cancel the wait.
 * @param {number} ms
 * @returns {{ promise: Promise<void>, cancel: () => void }}
 */
function cancellableSleep(ms) {
  /** @type {ReturnType<typeof setTimeout>} */
  let handle
  const promise = new Promise((resolve) => {
    handle = setTimeout(resolve, ms)
  })
  return { promise, cancel: () => clearTimeout(handle) }
}

/**
 * Owns one Context7 device-flow login: the pending authorization, its polling
 * loop, and the resulting credential write. One instance per plugin fiber.
 */
class Context7Login {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   */
  constructor(ctx) {
    this.ctx = ctx
    this.ref = credentialRef(API_KEY_REF)
    /** @type {boolean} */
    this.authenticated = false
    /** @type {null | { deviceCode: string, userCode: string, verificationUri: string, verificationUriComplete?: string, expiresAt: number, intervalMs: number }} */
    this.flow = null
    this.polling = false
    this.disposed = false
    /** @type {null | (() => void)} */
    this.cancelSleep = null
  }

  /** Re-read whether a Context7 API key is configured. */
  async refresh() {
    try {
      const info = await this.ctx.credentials.describe(this.ref)
      this.authenticated = Boolean(info && info.configured)
    } catch {
      this.authenticated = false
    }
    return this.authenticated
  }

  /**
   * Reuse a key the official `ctx7` CLI already stored, so a user who ran
   * `npx ctx7 setup` does not have to sign in a second time.
   * @returns {{ apiKey: string, path: string } | undefined}
   */
  importFromStore() {
    try {
      return readCtx7ApiKey()
    } catch {
      return undefined
    }
  }

  /**
   * Return a valid pending authorization, starting a new one when there is none
   * or the current one is about to expire.
   */
  async ensureFlow() {
    if (this.authenticated) return null
    if (this.flow && this.flow.expiresAt > Date.now() + 5_000) return this.flow

    let auth
    try {
      auth = await startDeviceAuthorization({ hostname: safeHostname() })
    } catch (error) {
      throw new Error(`无法开始 Context7 登录：${error instanceof Error ? error.message : String(error)}`)
    }

    this.flow = {
      deviceCode: auth.deviceCode,
      userCode: auth.userCode,
      verificationUri: auth.verificationUri,
      verificationUriComplete: auth.verificationUriComplete,
      expiresAt: Date.now() + auth.expiresIn * 1000,
      intervalMs: Math.max(auth.interval, 1) * 1000,
    }
    this.startPolling()
    return this.flow
  }

  /** Start the background approval poll if it is not already running. */
  startPolling() {
    if (this.polling || this.disposed) return
    this.polling = true
    void this.pollLoop().finally(() => {
      this.polling = false
    })
  }

  /** Poll until approved, denied, expired, or disposed. */
  async pollLoop() {
    while (!this.disposed && this.flow !== null) {
      if (Date.now() >= this.flow.expiresAt) {
        this.flow = null
        return
      }
      const sleep = cancellableSleep(this.flow.intervalMs)
      this.cancelSleep = sleep.cancel
      await sleep.promise
      this.cancelSleep = null
      if (this.disposed) return
      const current = this.flow
      if (current === null) return

      /** @type {Awaited<ReturnType<typeof pollDeviceToken>>} */
      let result
      try {
        result = await pollDeviceToken({ deviceCode: current.deviceCode })
      } catch {
        // Treat an unexpected poll error as transient; keep trying until expiry.
        result = { status: 'transient' }
      }

      if (result.status === 'approved') {
        await this.commit(result.accessToken)
        this.flow = null
        return
      }
      if (result.status === 'denied' || result.status === 'expired') {
        this.flow = null
        return
      }
      if (result.status === 'slow_down' || result.status === 'transient') {
        if (this.flow !== null) this.flow.intervalMs += BACKOFF_MS
        continue
      }
      // pending — keep the current cadence.
    }
  }

  /**
   * Store the issued API key; the credential update reconnects the MCP row.
   * @param {string} accessToken
   */
  async commit(accessToken) {
    await this.ctx.credentials.set(this.ref, accessToken)
    this.authenticated = true
  }

  /** Runs once at activation: reuse a ctx7 login, sign in, or get a link ready. */
  async bootstrap() {
    if (await this.refresh()) return
    const stored = this.importFromStore()
    if (stored) {
      try {
        await this.commit(stored.apiKey)
        console.log(`[context7-auth] 已从 ctx7 凭据文件导入 Context7 API Key（${stored.path}）。`)
        return
      } catch (error) {
        console.warn(
          `[context7-auth] 导入 ctx7 凭据失败，改用设备码登录：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    try {
      const flow = await this.ensureFlow()
      if (flow) {
        console.log(
          `[context7-auth] Context7 未登录，已发起 OAuth 设备码登录。请打开 ${flow.verificationUriComplete ?? flow.verificationUri} `
          + `并输入验证码 ${flow.userCode}；批准后 API Key 会自动保存。（也可让代理调用 context7_login 获取该链接）`,
        )
      }
    } catch (error) {
      console.warn(`[context7-auth] 发起 Context7 登录失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** React to a credential change for our reference. */
  async onCredentialChange() {
    if (await this.refresh()) this.flow = null
  }

  /** Stop polling and release timers. */
  dispose() {
    this.disposed = true
    if (this.cancelSleep) {
      this.cancelSleep()
      this.cancelSleep = null
    }
  }
}

/**
 * Best-effort device hostname; a missing value is harmless.
 * @returns {string | undefined}
 */
function safeHostname() {
  try {
    return hostname() || undefined
  } catch {
    return undefined
  }
}

/**
 * Plugin entry.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const login = new Context7Login(ctx)

  ctx.effect(() => () => login.dispose())

  // `inject` above waits for an active `credentials` provider, so the Context7
  // row's `${credential:…}` template is loadable here; a static patch row is
  // not (see context7-mcp.js).
  ctx.effect(() => mountContext7(ctx, McpClient), 'context7-auth.mcp-server')

  ctx.on('credentials/reference-updated', (subject) => {
    if (subject === String(credentialRef(API_KEY_REF))) {
      void login.onCredentialChange()
    }
  })

  ctx.systemPrompt.section({
    name: 'plugin:context7-auth',
    order: SECTION_ORDER,
    interpolate: false,
    text: () => (login.authenticated ? '' : LOGIN_NOTE),
  })

  ctx.tools.register(defineTool({
    name: 'context7_login',
    description:
      'Sign in to Context7 so its MCP docs tools become available. Returns the verification link and one-time code '
      + 'to give the user; the API key is saved automatically once they approve in the browser. Call this when the '
      + 'user needs Context7 documentation and the mcp__context7__ tools are missing or authentication is required.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          authenticated: { type: 'boolean', required: true },
          status: { type: 'string', required: true },
          verificationUrl: { type: 'string' },
          userCode: { type: 'string' },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute() {
      await login.refresh()
      if (login.authenticated) {
        return {
          authenticated: true,
          status: 'authenticated',
          message: 'Context7 已登录，API Key 已配置，可以直接使用 mcp__context7__ 工具。',
        }
      }
      const stored = login.importFromStore()
      if (stored) {
        try {
          await login.commit(stored.apiKey)
          return {
            authenticated: true,
            status: 'imported',
            message: `已从 ctx7 凭据文件（${stored.path}）导入 API Key，Context7 工具随即可用。`,
          }
        } catch (error) {
          throw new Error(`导入 ctx7 凭据失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      const flow = await login.ensureFlow()
      const url = flow.verificationUriComplete ?? flow.verificationUri
      return {
        authenticated: false,
        status: 'pending',
        verificationUrl: url,
        userCode: flow.userCode,
        message:
          `请打开 ${url} 并在浏览器中批准访问（一次性验证码：${flow.userCode}）。`
          + '批准后 API Key 会自动保存，Context7 工具随即可用；完成后重试你的请求即可。',
      }
    },
  }))

  void login.bootstrap()
}
