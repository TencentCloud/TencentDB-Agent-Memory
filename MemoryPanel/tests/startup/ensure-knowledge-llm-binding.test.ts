import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InstanceEntry } from '../../src/panel/config/instance-registry.js';
import type { Logger } from '../../src/panel/infra/logger.js';
import {
  ensureKnowledgeLlmBinding,
  type KnowledgeLlmBindingOptions,
} from '../../src/panel/startup/ensure-knowledge-llm-binding.js';

const instance: InstanceEntry = {
  instance_id: 'instance-1',
  name: 'Instance 1',
  gateway_endpoint: 'http://gateway.test',
  api_key: 'gateway-key',
};

const options: KnowledgeLlmBindingOptions = {
  knowledgeBaseUrl: 'http://knowledge.test',
  knowledgeAuthToken: 'knowledge-token',
  proxyBaseUrl: 'http://proxy.test',
  timeoutMs: 1_000,
};

function logger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

function existingBindings() {
  return new Map([
    ['instance-1', {
      service_id: 'instance-1',
      mode: 'proxy',
      proxy_base_url: 'http://old-proxy.test',
      base_url: null,
      has_api_key: true,
      enabled: true,
    }],
  ]);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ensureKnowledgeLlmBinding', () => {
  it('rejects non-success HTTP responses without an envelope code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })));

    await expect(
      ensureKnowledgeLlmBinding(instance, options, logger(), existingBindings()),
    ).rejects.toThrow('http 500');
  });

  it('accepts successful legacy responses without an envelope code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));

    await expect(
      ensureKnowledgeLlmBinding(instance, options, logger(), existingBindings()),
    ).resolves.toBe('bound');
  });
});
