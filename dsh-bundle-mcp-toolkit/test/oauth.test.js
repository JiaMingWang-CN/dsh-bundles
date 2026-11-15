import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startDeviceAuthorization, pollDeviceToken } from '../lib/oauth.js'

/** Minimal Response stand-in for the fields oauth.js reads. */
function fakeResponse({ ok = true, status = 200, json, text = '' }) {
  return {
    ok,
    status,
    json: async () => {
      if (json === undefined) throw new Error('no JSON body')
      return json
    },
    text: async () => text,
  }
}

test('startDeviceAuthorization maps the device-code response', async () => {
  let seenUrl
  let seenBody
  const fetchImpl = async (url, init) => {
    seenUrl = url
    seenBody = init.body
    return fakeResponse({
      json: {
        device_code: 'dev-1',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://context7.com/oauth/device',
        verification_uri_complete: 'https://context7.com/oauth/device?user_code=ABCD-EFGH',
        expires_in: 600,
        interval: 5,
      },
    })
  }

  const result = await startDeviceAuthorization({ fetchImpl, hostname: 'box' })
  assert.equal(seenUrl, 'https://context7.com/api/oauth/device/code')
  assert.match(seenBody, /client_id=2veBSofhicRBguUT/)
  assert.match(seenBody, /hostname=box/)
  assert.deepEqual(result, {
    deviceCode: 'dev-1',
    userCode: 'ABCD-EFGH',
    verificationUri: 'https://context7.com/oauth/device',
    verificationUriComplete: 'https://context7.com/oauth/device?user_code=ABCD-EFGH',
    expiresIn: 600,
    interval: 5,
  })
})

test('startDeviceAuthorization throws on a non-OK response', async () => {
  const fetchImpl = async () => fakeResponse({ ok: false, status: 400, text: 'bad request' })
  await assert.rejects(
    () => startDeviceAuthorization({ fetchImpl }),
    /HTTP 400.*bad request/,
  )
})

test('pollDeviceToken reports pending, then approved with the access token', async () => {
  const replies = [
    fakeResponse({ ok: false, status: 400, json: { error: 'authorization_pending' } }),
    fakeResponse({ ok: true, json: { access_token: 'ctx7sk-abc123', token_type: 'bearer' } }),
  ]
  const fetchImpl = async () => replies.shift()

  assert.deepEqual(
    await pollDeviceToken({ deviceCode: 'dev-1', fetchImpl }),
    { status: 'pending' },
  )

  const approved = await pollDeviceToken({ deviceCode: 'dev-1', fetchImpl })
  assert.equal(approved.status, 'approved')
  assert.equal(approved.accessToken, 'ctx7sk-abc123')
})

test('pollDeviceToken maps slow_down, denied and expired', async () => {
  const asError = (code) => async () =>
    fakeResponse({ ok: false, status: 400, json: { error: code } })

  assert.equal((await pollDeviceToken({ deviceCode: 'd', fetchImpl: asError('slow_down') })).status, 'slow_down')
  assert.equal((await pollDeviceToken({ deviceCode: 'd', fetchImpl: asError('access_denied') })).status, 'denied')
  assert.equal((await pollDeviceToken({ deviceCode: 'd', fetchImpl: asError('expired_token') })).status, 'expired')
})

test('pollDeviceToken treats a 5xx as transient and a network throw as transient', async () => {
  const server = async () => fakeResponse({ ok: false, status: 503, json: {} })
  assert.equal((await pollDeviceToken({ deviceCode: 'd', fetchImpl: server })).status, 'transient')

  const offline = async () => {
    throw new Error('ECONNRESET')
  }
  const result = await pollDeviceToken({ deviceCode: 'd', fetchImpl: offline })
  assert.equal(result.status, 'transient')
  assert.match(result.errorMessage, /ECONNRESET/)
})

test('pollDeviceToken throws when the approval carries no access token', async () => {
  const fetchImpl = async () => fakeResponse({ ok: true, json: { token_type: 'bearer' } })
  await assert.rejects(() => pollDeviceToken({ deviceCode: 'd', fetchImpl }), /no access token/)
})
