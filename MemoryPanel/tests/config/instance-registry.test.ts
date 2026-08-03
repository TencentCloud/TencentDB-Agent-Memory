import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  InstanceRegistry,
  InstanceRegistryError,
  type InstanceEntry,
} from '../../src/panel/config/instance-registry.js';

function instance(
  instanceId: string,
  endpoint = `https://${instanceId}.example`,
): InstanceEntry {
  return {
    instance_id: instanceId,
    name: instanceId,
    gateway_endpoint: endpoint,
    api_key: `secret-${instanceId}`,
  };
}

describe('InstanceRegistry', () => {
  it('rejects duplicate instance IDs when loading configuration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'panel-instance-registry-'));
    const configPath = join(dir, 'metadata-instances.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        instances: [
          {
            id: 'duplicate',
            name: 'first',
            gateway_endpoint: 'https://first.example',
            api_key: 'first-secret',
          },
          {
            id: 'duplicate',
            name: 'second',
            gateway_endpoint: 'https://second.example',
            api_key: 'second-secret',
          },
        ],
      }),
    );

    try {
      expect(() => InstanceRegistry.load(configPath)).toThrowError(
        new InstanceRegistryError(
          500,
          'duplicate metadata instance id: duplicate',
        ),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps distinct instances and omits credentials from public listings', () => {
    const registry = new InstanceRegistry([
      instance('first'),
      instance('second'),
    ]);

    expect(registry.listPublic()).toEqual([
      {
        instance_id: 'first',
        name: 'first',
        gateway_endpoint: 'https://first.example',
      },
      {
        instance_id: 'second',
        name: 'second',
        gateway_endpoint: 'https://second.example',
      },
    ]);
    expect(registry.resolve('second').api_key).toBe('secret-second');
  });
});
