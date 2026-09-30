/** Shared test helper: a fake memory-core gateway on an ephemeral port. */
import { createServer } from 'node:http'

export class FakeGateway {
  constructor() {
    this.requests = [] // { path, authorization, body }
    this.recallContext = "User's project codename is Apollo Lake."
    this.recallPrepend = ''
    this.searchResults = '[mem] codename=Apollo Lake'
    this.failRoutes = new Set()
    this.server = createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
      this.requests.push({
        path: req.url,
        authorization: req.headers.authorization || '',
        body,
      })
      if (this.failRoutes.has(req.url)) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'simulated failure' }))
        return
      }
      const [path] = req.url.split('?')
      const reply = this.reply(path, body)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply))
    })
  }

  reply(path, body) {
    switch (path) {
      case '/health':
        return { status: 'ok', version: 'test-gateway' }
      case '/capture':
        return { l0_recorded: body?.messages?.length || 0, scheduler_notified: true }
      case '/recall':
        return {
          context: this.recallContext,
          prepend_context: this.recallPrepend,
          strategy: 'semantic',
          memory_count: this.recallContext || this.recallPrepend ? 1 : 0,
        }
      case '/search/memories':
        return { results: this.searchResults, total: 1, strategy: 'semantic' }
      case '/search/conversations':
        return { results: '[conv] asked about codename', total: 1 }
      case '/session/end':
        return { flushed: true }
      default:
        return {}
    }
  }

  listen() {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const { port } = this.server.address()
        resolve(`http://127.0.0.1:${port}`)
      })
    })
  }

  close() {
    return new Promise((resolve) => this.server.close(resolve))
  }

  payloads(path) {
    return this.requests.filter((r) => r.path === path).map((r) => r.body)
  }
}

/** A minimal DSH plugin-context double capturing registrations and events. */
export class FakeCtx {
  constructor() {
    this.listeners = new Map()
    this.tools = new Map()
    this.promptSections = []
    this.logger = { warn: () => {} }
    this.tools.register = (tool) => {
      this.tools.set(tool.name, tool)
    }
    this.systemPrompt = {
      section: (section) => {
        this.promptSections.push(section)
      },
    }
  }

  on(event, listener) {
    const list = this.listeners.get(event) || []
    list.push(listener)
    this.listeners.set(event, list)
  }

  async emit(event, ...args) {
    const list = this.listeners.get(event) || []
    for (const listener of list) await listener(...args)
  }

  tool(name) {
    return this.tools.get(name)
  }
}

/** A minimal session/agent double for driving lifecycle events. */
export function fakeSession(sessionId) {
  return { id: sessionId }
}

export function fakeAgent(sessionId) {
  return { session: fakeSession(sessionId) }
}

/** Drive one session turn through session/event + agent/turn-stopping. */
export async function runTurn(ctx, sessionId, turn, userText, assistantText) {
  await ctx.emit('session/event', fakeSession(sessionId), {
    type: 'turn/start',
    data: { turn },
  })
  await ctx.emit('session/event', fakeSession(sessionId), {
    type: 'user/message',
    data: { content: [{ type: 'text', text: userText }] },
  })
  await ctx.emit('session/event', fakeSession(sessionId), {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: assistantText }] } },
  })
  await ctx.emit('agent/turn-stopping', {
    agent: fakeAgent(sessionId),
    turn,
    signal: new AbortController().signal,
  })
}
