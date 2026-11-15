/**
 * Read the Context7 API key that the official `ctx7` CLI already stored.
 *
 * `npx ctx7 setup` / `ctx7 login` authenticate with Context7 and write a
 * `credentials.json` whose `access_token` is the long-lived API key. When a
 * user has already used the official CLI, there is no reason to make them sign
 * in again: this module locates that file and returns the key so the host plugin
 * can import it into the DSH credential store before falling back to its own
 * device-flow login.
 *
 * The locations mirror the upstream CLI (packages/cli/src/utils/storage-paths.ts):
 * `$XDG_CONFIG_HOME/context7/credentials.json` (default `~/.config/context7/...`)
 * plus the legacy `~/.context7/credentials.json`. `env` and `homedir` are
 * injectable for tests.
 *
 * @module @wjm200509/dsh-bundle-mcp-toolkit/ctx7-store
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** Directory name the CLI uses under its config base. */
const APP_DIR = 'context7'

/** Credential file name written by the CLI. */
const CREDENTIALS_FILE = 'credentials.json'

/**
 * Candidate credential-file paths, in preference order.
 * @param {{ env?: Record<string, string | undefined>, homedir?: string }} [options]
 * @returns {string[]}
 */
export function ctx7CredentialsPaths(options = {}) {
  const env = options.env ?? process.env
  const home = options.homedir ?? osHomedir()
  // Per the XDG spec a relative or empty XDG_CONFIG_HOME is ignored.
  const xdg = env.XDG_CONFIG_HOME
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, '.config')
  return [
    join(base, APP_DIR, CREDENTIALS_FILE),
    join(home, '.context7', CREDENTIALS_FILE),
  ]
}

/**
 * Read the first usable API key from the CLI's credential files.
 *
 * Malformed or empty entries are skipped; a missing file is not an error. This
 * never throws — an unusable store simply means "fall back to device flow".
 *
 * @param {{ env?: Record<string, string | undefined>, homedir?: string }} [options]
 * @returns {{ apiKey: string, path: string } | undefined}
 */
export function readCtx7ApiKey(options = {}) {
  for (const file of ctx7CredentialsPaths(options)) {
    if (!existsSync(file)) continue
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      const token = data && typeof data.access_token === 'string' ? data.access_token.trim() : ''
      if (token.length > 0) return { apiKey: token, path: file }
    } catch {
      // Corrupt or unreadable file: try the next candidate.
    }
  }
  return undefined
}
