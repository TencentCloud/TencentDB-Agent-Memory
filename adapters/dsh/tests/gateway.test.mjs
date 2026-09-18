/** Gateway client contract tests against a fake HTTP gateway. */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  GatewayError,
  TdaiGatewayClient,
  gatewayMessage,
  sessionKey,
  textFromContent,
} from '../gateway.mjs'
import { FakeGateway } from './helpers.mjs'

test('health returns status and version', async () => {
  const gw = new FakeGateway()
  const url = await gw.listen()
  try {
    const client = new TdaiGatewayClient({ endpoint: url })
    const health = await client.health()
    assert.equal(health.status, 'ok')
    assert.equal(health.version, 'test-gateway')
  } finally {
    await gw.close()
  }
})

test('write paths carry the bearer token, health does not require it', async () => {
  const gw = new FakeGateway()
  const url = await gw.listen()
  try {
    const client = new TdaiGatewayClient({ endpoint: url, apiKey: 'k1' })
    await client.recall({ query: 'q', sessionKey: 's:k', userId: 'u' })
    await client.searchMemories({ query: 'q', userId: 'u' })
    await client.searchConversations({ query: 'q', userId: 'u' })
    await client.endSession({ sessionKey: 's:k', userId: 'u' })
    const byPath = Object.fromEntries(gw.requests.map((r) => [r.path, r.authorization]))
    assert.equal(byPath['/recall'], 'Bearer k1')
    assert.equal(byPath['/search/memories'], 'Bearer k1')
    assert.equal(byPath['/search/conversations'], 'Bearer k1')
    assert.equal(byPath['/session/end'], 'Bearer k1')
  } finally {
    await gw.close()
  }
})

test('capture sends the full payload shape', async () => {
  const gw = new FakeGateway()
  const url = await gw.listen()
  try {
    const client = new TdaiGatewayClient({ endpoint: url })
    await client.capture({
      userContent: 'remember my codename',
      assistantContent: 'noted',
      sessionKey: 's:k',
      sessionId: 't-1',
      userId: 'u',
      messages: [
        gatewayMessage('user', 'remember my codename', 100),
        gatewayMessage('assistant', 'noted', 101),
      ],
    })
    const payload = gw.payloads('/capture')[0]
    assert.equal(payload.user_content, 'remember my codename')
    assert.equal(payload.assistant_content, 'noted')
    assert.equal(payload.session_key, 's:k')
    assert.equal(payload.session_id, 't-1')
    assert.equal(payload.user_id, 'u')
    assert.deepEqual(payload.messages, [
      { role: 'user', content: 'remember my codename', timestamp: 100 },
      { role: 'assistant', content: 'noted', timestamp: 101 },
    ])
  } finally {
    await gw.close()
  }
})

test('recall payload and result mapping, with prepend fallback', async () => {
  const gw = new FakeGateway()
  const url = await gw.listen()
  try {
    const client = new TdaiGatewayClient({ endpoint: url })
    const recall = await client.recall({ query: 'codename?', sessionKey: 's:k', userId: 'u' })
    assert.ok(recall.context.includes('Apollo Lake'))
    assert.equal(recall.memoryCount, 1)
    assert.deepEqual(gw.payloads('/recall')[0], {
      query: 'codename?',
      session_key: 's:k',
      user_id: 'u',
    })
  } finally {
    await gw.close()
  }
})

test('search payload shapes', async () => {
  const gw = new FakeGateway()
  const url = await gw.listen()
  try {
    const client = new TdaiGatewayClient({ endpoint: url })
    const memories = await client.searchMemories({ query: 'codename', limit: 3, userId: 'u' })
    assert.ok(memories.results.includes('Apollo Lake'))
    await client.searchConversations({ query: 'codename', limit: 2, sessionKey: 's:k' })
    assert.deepEqual(gw.payloads('/search/memories')[0], {
      query: 'codename',
      limit: 3,
      user_id: 'u',
    })
    assert.deepEqual(gw.payloads('/search/conversations')[0], {
      query: 'codename',
      limit: 2,
      session_key: 's:k',
    })
  } finally {
    await gw.close()
  }
})

test('server errors raise GatewayError with status', async () => {
  const gw = new FakeGateway()
  gw.failRoutes.add('/recall')
  const url = await gw.listen()
  try {
    const client = new TdaiGatewayClient({ endpoint: url })
    await assert.rejects(
      () => client.recall({ query: 'q', sessionKey: 's:k' }),
      (error) => error instanceof GatewayError && error.status === 500,
    )
  } finally {
    await gw.close()
  }
})

test('unreachable gateway raises GatewayError', async () => {
  const client = new TdaiGatewayClient({ endpoint: 'http://127.0.0.1:1' })
  await assert.rejects(() => client.health(), GatewayError)
})

test('invalid endpoint is rejected at construction', () => {
  assert.throws(() => new TdaiGatewayClient({ endpoint: 'ftp://x' }), GatewayError)
  assert.throws(() => new TdaiGatewayClient({ endpoint: '' }), GatewayError)
})

test('sessionKey mirrors the trpc-agent-go b64url composite', () => {
  const key = sessionKey('app', 'user', 't-1')
  const parts = key.split(':')
  assert.deepEqual(
    parts.map((p) => Buffer.from(p, 'base64url').toString('utf8')),
    ['app', 'user', 't-1'],
  )
  assert.ok(key.endsWith('dC0x')) // b64url('t-1')
})

test('textFromContent handles strings, parts arrays, and junk', () => {
  assert.equal(textFromContent('plain'), 'plain')
  assert.equal(textFromContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(textFromContent([{ type: 'image' }]), '')
  assert.equal(textFromContent(null), '')
  assert.equal(textFromContent(42), '')
})
