/** Plugin behavior tests: registration, recall injection, capture semantics. */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply, name } from '../index.mjs'
import { FakeCtx, FakeGateway, fakeAgent, runTurn } from './helpers.mjs'

function makePlugin(url, config = {}) {
  const ctx = new FakeCtx()
  apply(ctx, { endpoint: url, appName: 'app', userId: 'user', ...config })
  return ctx
}

test('plugin registers prompt section and both tools by default', async () => {
  const gw = new FakeGateway()
  const url = await gw.listen()
  try {
    const ctx = makePlugin(url)
    assert.equal(name, 'tdai-memory-dsh')
    assert.equal(ctx.promptSections.length, 1)
    assert.equal(ctx.promptSections[0].name, 'tdai-memory')
    assert.ok(ctx.tools.has('tdai_memory_search'))
    assert.ok(ctx.tools.has('tdai_conversation_search'))
  } finally {
    await gw.close()
  }
})

test('tool toggles remove the corresponding registration', async () => {
  const gw = new FakeGateway()
  const url = await gw.listen()
  try {
    const ctx = makePlugin(url, { memorySearchTool: false })
    assert.ok(!ctx.tools.has('tdai_memory_search'))
    assert.ok(ctx.tools.has('tdai_conversation_search'))
  } finally {
    await gw.close()
  }
})

test('tools execute against the gateway with user scope', async () => {
  const gw = new FakeGateway()
  const url = await gw.listen()
  try {
    const ctx = makePlugin(url)
    const result = await ctx.tool('tdai_memory_search').execute({ query: 'codename', limit: 3 })
    assert.ok(result.includes('Apollo Lake'))
    const payload = gw.payloads('/search/memories')[0]
    assert.deepEqual(payload, { query: 'codename', limit: 3, user_id: 'user' })
    await ctx.tool('tdai_conversation_search').execute({ query: 'codename' })
    assert.deepEqual(gw.payloads('/search/conversations')[0], {
      query: 'codename',
      limit: 5,
      user_id: 'user',
    })
  } finally {
    await gw.close()
  }
})

test('tool failure is fail-open by default, raised when failOpen=false', async () => {
  const gw = new FakeGateway()
  gw.failRoutes.add('/search/memories')
  const url = await gw.listen()
  try {
    const open = makePlugin(url)
    const result = await open.tool('tdai_memory_search').execute({ query: 'q' })
    assert.ok(result.includes('temporarily unavailable'))

    const closed = makePlugin(url, { failOpen: false })
    await assert.rejects(() => closed.tool('tdai_memory_search').execute({ query: 'q' }))
  } finally {
    await gw.close()
  }
})

test('completed turn is captured once with the full payload', async () => {
  const gw = new FakeGateway()
  const url = await gw.listen()
  try {
    const ctx = makePlugin(url)
    await runTurn(ctx, 's-1', 1, 'remember my codename is Apollo Lake', 'noted')

    const captures = gw.payloads('/capture')
    assert.equal(captures.length, 1)
    const payload = captures[0]
    assert.equal(payload.user_content, 'remember my codename is Apollo Lake')
    assert.equal(payload.assistant_content, 'noted')
    assert.equal(payload.session_id, 's-1')
    assert.equal(payload.user_id, 'user')
    assert.equal(payload.messages.length, 2)
    assert.equal(payload.messages[0].role, 'user')
    assert.equal(payload.messages[1].role, 'assistant')
    const decoded = payload.session_key.split(':').map((p) =>
      Buffer.from(p, 'base64url').toString('utf8'))
    assert.deepEqual(decoded, ['app', 'user', 's-1'])

    // A second flush for the same (unchanged) turn must not resend.
    await ctx.emit('agent/turn-stopping', {
      agent: fakeAgent('s-1'),
      turn: 1,
      signal: new AbortController().signal,
    })
    assert.equal(gw.payloads('/capture').length, 1)
  } finally {
    await gw.close()
  }
})

test('incomplete turn (lone user message) captures nothing', async () => {
  const gw = new FakeGateway()
  const url = await gw.listen()
  try {
    const ctx = makePlugin(url)
    await ctx.emit('session/event', { id: 's-1' }, { type: 'turn/start', data: { turn: 1 } })
    await ctx.emit('session/event', { id: 's-1' }, {
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'orphan' }] },
    })
    await ctx.emit('agent/turn-stopping', {
      agent: fakeAgent('s-1'),
      turn: 1,
      signal: new AbortController().signal,
    })
    assert.equal(gw.payloads('/capture').length, 0)
  } finally {
    await gw.close()
  }
})

test('failed capture is retried on the next flush, exactly once on success', async () => {
  const gw = new FakeGateway()
  gw.failRoutes.add('/capture')
  const url = await gw.listen()
  try {
    const ctx = makePlugin(url)
    await ctx.emit('session/event', { id: 's-1' }, { type: 'turn/start', data: { turn: 1 } })
    await ctx.emit('session/event', { id: 's-1' }, {
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'q1' }] },
    })
    await ctx.emit('session/event', { id: 's-1' }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'a1' }] } },
    })
    // First flush fails (fail-open: swallowed).
    await ctx.emit('agent/turn-stopping', {
      agent: fakeAgent('s-1'),
      turn: 1,
      signal: new AbortController().signal,
    })
    assert.equal(gw.payloads('/capture').length, 1) // the failed attempt reached the gateway

    gw.failRoutes.clear() // gateway recovers
    await ctx.emit('agent/turn-stopping', {
      agent: fakeAgent('s-1'),
      turn: 1,
      signal: new AbortController().signal,
    })
    const captures = gw.payloads('/capture')
    assert.equal(captures.length, 2) // failed attempt + successful retry
    assert.equal(captures[1].user_content, 'q1')

    // Third flush is a no-op: the turn was consumed by the success.
    await ctx.emit('agent/turn-stopping', {
      agent: fakeAgent('s-1'),
      turn: 1,
      signal: new AbortController().signal,
    })
    assert.equal(gw.payloads('/capture').length, 2)
  } finally {
    await gw.close()
  }
})

test('per-session staging is isolated and cleaned on dispose', async () => {
  const gw = new FakeGateway()
  const url = await gw.listen()
  try {
    const ctx = makePlugin(url)
    await runTurn(ctx, 'a', 1, 'qa', 'aa')
    await runTurn(ctx, 'b', 1, 'qb', 'ab')
    const captures = gw.payloads('/capture')
    assert.equal(captures.length, 2)
    assert.deepEqual(captures.map((c) => c.session_id).sort(), ['a', 'b'])

    await ctx.emit('session/disposed', { id: 'a' })
    // b still flushes independently; a's state is gone.
    await runTurn(ctx, 'b', 2, 'qb2', 'ab2')
    assert.equal(gw.payloads('/capture').length, 3)
    assert.equal(gw.payloads('/capture')[2].session_id, 'b')
  } finally {
    await gw.close()
  }
})

test('pre-step recall injects untrusted-marked context as a user message', async () => {
  const gw = new FakeGateway()
  const url = await gw.listen()
  try {
    const ctx = makePlugin(url)
    const decision = await drivePreStep(ctx)
    assert.equal(decision.kind, 'enter')
    assert.equal(decision.messages.length, 2)
    const injected = decision.messages[1]
    assert.equal(injected.role, 'user')
    const text = injected.content[0].text
    assert.ok(text.includes('Apollo Lake'))
    assert.ok(text.includes('untrusted'))
    assert.ok(gw.payloads('/recall').length === 1)
  } finally {
    await gw.close()
  }
})

test('pre-step recall with empty context leaves the decision untouched', async () => {
  const gw = new FakeGateway()
  gw.recallContext = ''
  gw.recallPrepend = ''
  const url = await gw.listen()
  try {
    const ctx = makePlugin(url)
    const decision = await drivePreStep(ctx)
    assert.equal(decision.messages.length, 1) // no injection
    assert.equal(gw.payloads('/recall').length, 1) // gateway was called
  } finally {
    await gw.close()
  }
})

test('pre-step recall falls back to prepend_context', async () => {
  const gw = new FakeGateway()
  gw.recallContext = ''
  gw.recallPrepend = 'User prefers concise answers.'
  const url = await gw.listen()
  try {
    const ctx = makePlugin(url)
    const decision = await drivePreStep(ctx)
    assert.ok(decision.messages[1].content[0].text.includes('concise answers'))
  } finally {
    await gw.close()
  }
})

test('pre-step recall failure is fail-open by default', async () => {
  const gw = new FakeGateway()
  gw.failRoutes.add('/recall')
  const url = await gw.listen()
  try {
    const ctx = makePlugin(url)
    const decision = await drivePreStep(ctx)
    assert.equal(decision.messages.length, 1) // passthrough
  } finally {
    await gw.close()
  }
})

test('recall disabled registers no pre-step listener', async () => {
  const gw = new FakeGateway()
  const url = await gw.listen()
  try {
    const ctx = makePlugin(url, { recallEnabled: false })
    assert.ok(!ctx.listeners.has('agent/pre-step'))
  } finally {
    await gw.close()
  }
})

test('reject decisions and aborted signals skip recall', async () => {
  const gw = new FakeGateway()
  const url = await gw.listen()
  try {
    const ctx = makePlugin(url)
    const listeners = ctx.listeners.get('agent/pre-step')
    const listener = listeners[0]

    const rejected = await listener(
      { agent: fakeAgent('s-1'), signal: new AbortController().signal, messages: [] },
      async () => ({ kind: 'reject', reason: 'nope' }),
    )
    assert.equal(rejected.kind, 'reject')
    assert.equal(gw.payloads('/recall').length, 0)

    const controller = new AbortController()
    controller.abort()
    const aborted = await listener(
      { agent: fakeAgent('s-1'), signal: controller.signal, messages: [{ role: 'user', content: 'q' }] },
      async () => ({ kind: 'enter', messages: [{ role: 'user', content: 'q' }] }),
    )
    assert.equal(aborted.messages.length, 1)
    assert.equal(gw.payloads('/recall').length, 0)
  } finally {
    await gw.close()
  }
})

/** Drive the registered pre-step listener with a base enter decision. */
async function drivePreStep(ctx) {
  const listeners = ctx.listeners.get('agent/pre-step')
  assert.ok(listeners?.length >= 1)
  const listener = listeners[listeners.length - 1]
  const base = { kind: 'enter', messages: [{ role: 'user', content: 'what is my codename?' }] }
  return listener(
    {
      agent: fakeAgent('s-1'),
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'what is my codename?' }] }],
    },
    async () => base,
  )
}
