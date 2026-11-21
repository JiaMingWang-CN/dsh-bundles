import { test } from 'node:test'
import assert from 'node:assert/strict'

import { API_KEY_REF, CONTEXT7_MCP_CONFIG, mountContext7 } from '../lib/context7-mcp.js'

test('the row keeps the credential template and never a plaintext key', () => {
  assert.equal(API_KEY_REF, 'CONTEXT7_API_KEY')
  assert.equal(CONTEXT7_MCP_CONFIG.transport, 'stdio')
  assert.equal(CONTEXT7_MCP_CONFIG.serverName, 'context7')
  assert.equal(CONTEXT7_MCP_CONFIG.expandTemplates, true)
  assert.equal(CONTEXT7_MCP_CONFIG.env.CONTEXT7_API_KEY, '${credential:CONTEXT7_API_KEY}')
  assert.deepEqual(CONTEXT7_MCP_CONFIG.args, ['-y', '@upstash/context7-mcp@4.5.0'])
})

test('mountContext7 mounts the client under the plugin fiber and disposes it', async () => {
  const mounted = []
  let disposed = 0
  const mcpClient = { name: 'mcp-client', apply() {} }
  const ctx = {
    plugin(plugin, config) {
      mounted.push({ plugin, config })
      return {
        await: () => Promise.resolve(),
        dispose: async () => {
          disposed += 1
        },
      }
    },
  }

  const dispose = mountContext7(ctx, mcpClient)

  assert.equal(mounted.length, 1)
  assert.equal(mounted[0].plugin, mcpClient)
  assert.equal(mounted[0].config, CONTEXT7_MCP_CONFIG)

  await dispose()
  assert.equal(disposed, 1)
})
