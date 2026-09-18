import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';

import { run } from '../lib/cli.mjs';

const silent = { log() {}, error() {} };

describe('integration against a local mock gateway', () => {
  let server;
  let base;
  let seen;

  before(async () => {
    seen = [];
    server = createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        seen.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });

        if (req.method === 'GET' && req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        } else if (req.method === 'POST' && /^\/proxy\/[^/]+\/v1\/chat\/completions$/.test(req.url)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'cmpl-1',
              object: 'chat.completion',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'pong' },
                  finish_reason: 'stop',
                },
              ],
            }),
          );
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end('{"error":"not found"}');
        }
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    server.close();
  });

  it('check --probe reaches the documented proxy route with identity headers', async () => {
    seen = [];
    const env = {
      TDAI_PROXY_BASE_URL: base,
      TDAI_CORE_BASE_URL: base,
      TDAI_SPACE_ID: 'default',
      TDAI_UPSTREAM_MODEL: 'gpt-test',
      TDAI_USER_KEY: 'sk-mem-test',
    };
    const code = await run(['check', '--probe'], { env, stdout: silent, stderr: silent });
    assert.equal(code, 0);

    assert.equal(seen.filter((req) => req.url === '/health').length, 2);
    const probe = seen.find((req) => req.method === 'POST');
    assert.ok(probe, 'expected a probe request');
    assert.equal(probe.url, '/proxy/default/v1/chat/completions');
    assert.equal(probe.headers['x-tdai-user-key'], 'sk-mem-test');
    assert.equal(probe.headers.authorization, 'Bearer sk-mem-test');
    assert.equal(JSON.parse(probe.body).model, 'gpt-test');
  });

  it('check --probe honors a custom space id in the route', async () => {
    seen = [];
    const env = {
      TDAI_PROXY_BASE_URL: base,
      TDAI_CORE_BASE_URL: base,
      TDAI_SPACE_ID: 'team-b',
      TDAI_UPSTREAM_MODEL: 'gpt-test',
      TDAI_USER_KEY: 'sk-mem-test',
    };
    const code = await run(['check', '--probe'], { env, stdout: silent, stderr: silent });
    assert.equal(code, 0);
    const probe = seen.find((req) => req.method === 'POST');
    assert.equal(probe.url, '/proxy/team-b/v1/chat/completions');
  });

  it('check without --probe never sends a chat request', async () => {
    seen = [];
    const env = {
      TDAI_PROXY_BASE_URL: base,
      TDAI_CORE_BASE_URL: base,
      TDAI_UPSTREAM_MODEL: 'gpt-test',
      TDAI_USER_KEY: 'sk-mem-test',
    };
    const code = await run(['check'], { env, stdout: silent, stderr: silent });
    assert.equal(code, 0);
    assert.equal(seen.filter((req) => req.method === 'POST').length, 0);
  });

  it('fails cleanly when the gateway is unreachable', async () => {
    const env = {
      TDAI_PROXY_BASE_URL: 'http://127.0.0.1:1',
      TDAI_CORE_BASE_URL: 'http://127.0.0.1:1',
      TDAI_UPSTREAM_MODEL: 'gpt-test',
      TDAI_USER_KEY: 'sk-mem-test',
    };
    const code = await run(['check'], { env, stdout: silent, stderr: silent });
    assert.equal(code, 1);
  });
});

describe('integration failure paths', () => {
  const startServer = async (handler) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { server, base: `http://127.0.0.1:${server.address().port}` };
  };

  it('fails when /health is unhealthy', async () => {
    const { server, base } = await startServer((req, res) => {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end('{"status":"degraded"}');
    });
    try {
      const env = {
        TDAI_PROXY_BASE_URL: base,
        TDAI_CORE_BASE_URL: base,
        TDAI_UPSTREAM_MODEL: 'gpt-test',
        TDAI_USER_KEY: 'sk-mem-test',
      };
      let err = '';
      const code = await run(['check'], {
        env,
        stdout: silent,
        stderr: { log: (s) => (err += s), error: (s) => (err += s) },
      });
      assert.equal(code, 1);
      assert.match(err, /MemoryProxy/);
    } finally {
      server.close();
    }
  });

  it('fails when the chat probe receives a 401 from upstream', async () => {
    const { server, base } = await startServer((req, res) => {
      if (req.method === 'POST') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":{"message":"bad key"}}');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"status":"ok"}');
      }
    });
    try {
      const env = {
        TDAI_PROXY_BASE_URL: base,
        TDAI_CORE_BASE_URL: base,
        TDAI_UPSTREAM_MODEL: 'gpt-test',
        TDAI_USER_KEY: 'sk-mem-test',
      };
      let err = '';
      const code = await run(['check', '--probe'], {
        env,
        stdout: silent,
        stderr: { log: (s) => (err += s), error: (s) => (err += s) },
      });
      assert.equal(code, 1);
      assert.match(err, /chat probe failed/);
    } finally {
      server.close();
    }
  });
});
