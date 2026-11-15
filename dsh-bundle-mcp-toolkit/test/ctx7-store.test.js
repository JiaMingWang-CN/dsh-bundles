import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCtx7ApiKey, ctx7CredentialsPaths } from '../lib/ctx7-store.js'

/** Create `<root>/.config/context7/credentials.json` (or a custom base). */
function writeStore(root, body, baseParts = ['.config', 'context7']) {
  const dir = join(root, ...baseParts)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'credentials.json')
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body))
  return file
}

test('reads access_token from the default ~/.config/context7/credentials.json', () => {
  const home = mkdtempSync(join(tmpdir(), 'ctx7-home-'))
  try {
    const file = writeStore(home, { access_token: 'ctx7sk-abc', token_type: 'bearer' })
    const found = readCtx7ApiKey({ homedir: home, env: {} })
    assert.deepEqual(found, { apiKey: 'ctx7sk-abc', path: file })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('honours an absolute XDG_CONFIG_HOME', () => {
  const home = mkdtempSync(join(tmpdir(), 'ctx7-home-'))
  const xdg = mkdtempSync(join(tmpdir(), 'ctx7-xdg-'))
  try {
    const file = writeStore(xdg, { access_token: 'ctx7sk-xdg' }, ['context7'])
    const found = readCtx7ApiKey({ homedir: home, env: { XDG_CONFIG_HOME: xdg } })
    assert.equal(found.apiKey, 'ctx7sk-xdg')
    assert.equal(found.path, file)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(xdg, { recursive: true, force: true })
  }
})

test('ignores a relative XDG_CONFIG_HOME and falls back to ~/.config', () => {
  const home = mkdtempSync(join(tmpdir(), 'ctx7-home-'))
  try {
    writeStore(home, { access_token: 'ctx7sk-rel' })
    const found = readCtx7ApiKey({ homedir: home, env: { XDG_CONFIG_HOME: 'relative/dir' } })
    assert.equal(found.apiKey, 'ctx7sk-rel')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('falls back to the legacy ~/.context7/credentials.json', () => {
  const home = mkdtempSync(join(tmpdir(), 'ctx7-home-'))
  try {
    const file = writeStore(home, { access_token: 'ctx7sk-legacy' }, ['.context7'])
    const found = readCtx7ApiKey({ homedir: home, env: {} })
    assert.equal(found.apiKey, 'ctx7sk-legacy')
    assert.equal(found.path, file)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('skips malformed JSON, an empty token, and missing files', () => {
  const home = mkdtempSync(join(tmpdir(), 'ctx7-home-'))
  try {
    assert.equal(readCtx7ApiKey({ homedir: home, env: {} }), undefined)
    writeStore(home, '{not json')
    assert.equal(readCtx7ApiKey({ homedir: home, env: {} }), undefined)
    writeStore(home, { access_token: '   ' })
    assert.equal(readCtx7ApiKey({ homedir: home, env: {} }), undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('path list prefers the XDG/default location before the legacy one', () => {
  const paths = ctx7CredentialsPaths({ homedir: 'C:/Users/x', env: {} })
  assert.equal(paths.length, 2)
  assert.match(paths[0], /[\\/]\.config[\\/]context7[\\/]credentials\.json$/)
  assert.match(paths[1], /[\\/]\.context7[\\/]credentials\.json$/)
})
