import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const patch = await readFile(new URL('../patch.yml', import.meta.url), 'utf8')
/** The entries only: comments explain the rule and must not satisfy or break it. */
const entries = patch
  .split(/\r?\n/)
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')

test('no static loader row carries a credential template', () => {
  assert.equal(
    /\$\{credential:/.test(entries),
    false,
    'dsh-mcp-client rejects a `${credential:…}` row at load unless a credentials provider is already ACTIVE, '
      + 'and loader entries start inside the window where dsh-credentials-local is still initialising; '
      + 'such a row fails on every Host start. Mount it from the host plugin instead.',
  )
})

test('the Context7 row is mounted by the host plugin, not configured statically', () => {
  assert.match(entries, /id: context7-auth/)
  assert.doesNotMatch(entries, /id: mcp-context7/)
})

test('CodeGraph stays a plain loader row with its pinned version', () => {
  assert.match(entries, /id: mcp-codegraph/)
  assert.match(entries, /@colbymchenry\/codegraph@1\.6\.2/)
})
