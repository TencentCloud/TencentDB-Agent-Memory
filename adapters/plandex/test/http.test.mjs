import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildHealthUrl, getJson, postChatCompletion } from '../lib/http.mjs';

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const pendingUntilAbort = () =>
  (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted.', 'AbortError')),
      );
    });

describe('buildHealthUrl', () => {
  it('joins the /health endpoint', () => {
    assert.equal(buildHealthUrl('http://127.0.0.1:8096'), 'http://127.0.0.1:8096/health');
  });
});

describe('getJson', () => {
  it('returns ok for 2xx JSON responses', async () => {
    const result = await getJson('http://proxy/health', {
      fetchImpl: async () => jsonResponse(200, { status: 'ok' }),
    });
    assert.deepEqual(result, { ok: true, status: 200, body: { status: 'ok' } });
  });

  it('reports non-2xx responses', async () => {
    const result = await getJson('http://proxy/health', {
      fetchImpl: async () => jsonResponse(503, { status: 'degraded' }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
  });

  it('reports network errors without throwing', async () => {
    const result = await getJson('http://proxy/health', {
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /ECONNREFUSED/);
  });

  it('reports malformed JSON without throwing', async () => {
    const result = await getJson('http://proxy/health', {
      fetchImpl: async () => new Response('not-json', { status: 200 }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /json/i);
  });

  it('times out instead of hanging forever', async () => {
    const result = await getJson('http://proxy/health', {
      fetchImpl: pendingUntilAbort(),
      timeoutMs: 15,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /timed out after 15ms/);
  });

  it('forwards custom headers to the fetch implementation', async () => {
    let seenHeaders;
    await getJson('http://proxy/health', {
      headers: { 'x-custom': 'yes' },
      fetchImpl: async (url, init) => {
        seenHeaders = init.headers;
        return jsonResponse(200, { status: 'ok' });
      },
    });
    assert.equal(seenHeaders['x-custom'], 'yes');
  });
});

describe('postChatCompletion', () => {
  it('POSTs to the proxy route with identity headers', async () => {
    let seen;
    const result = await postChatCompletion({
      baseUrl: 'http://127.0.0.1:8096',
      spaceId: 'default',
      model: 'gpt-5.5',
      apiKey: 'sk-mem-x',
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return jsonResponse(200, { choices: [] });
      },
    });
    assert.equal(result.ok, true);
    assert.equal(seen.url, 'http://127.0.0.1:8096/proxy/default/v1/chat/completions');
    assert.equal(seen.init.headers['x-tdai-user-key'], 'sk-mem-x');
    assert.equal(seen.init.headers.Authorization, 'Bearer sk-mem-x');
    const body = JSON.parse(seen.init.body);
    assert.equal(body.model, 'gpt-5.5');
    assert.equal(body.max_tokens, 1);
    assert.equal(body.messages[0].role, 'user');
  });

  it('normalizes a trailing slash on the base URL to avoid double slashes', async () => {
    let seenUrl;
    await postChatCompletion({
      baseUrl: 'http://127.0.0.1:8096/',
      spaceId: 'default',
      model: 'gpt-5.5',
      apiKey: 'sk-mem-x',
      fetchImpl: async (url) => {
        seenUrl = url;
        return jsonResponse(200, { choices: [] });
      },
    });
    assert.equal(seenUrl, 'http://127.0.0.1:8096/proxy/default/v1/chat/completions');
  });

  it('reports upstream failures', async () => {
    const result = await postChatCompletion({
      baseUrl: 'http://proxy',
      spaceId: 'default',
      model: 'm',
      apiKey: 'k',
      fetchImpl: async () => jsonResponse(401, { error: { message: 'bad key' } }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  });

  it('reports a non-JSON success body without throwing', async () => {
    const result = await postChatCompletion({
      baseUrl: 'http://proxy',
      spaceId: 'default',
      model: 'm',
      apiKey: 'k',
      fetchImpl: async () => new Response('not-json', { status: 200 }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /json/i);
  });

  it('times out instead of hanging forever', async () => {
    const result = await postChatCompletion({
      baseUrl: 'http://proxy',
      spaceId: 'default',
      model: 'm',
      apiKey: 'k',
      fetchImpl: pendingUntilAbort(),
      timeoutMs: 15,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /timed out after 15ms/);
  });
});
