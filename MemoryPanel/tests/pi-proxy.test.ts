import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { piProxyEndpoint, piProxySetup } from '../web/src/lib/pi-proxy.js';

describe('Pi setup', () => {
  it('builds a versioned endpoint for the current instance', () => {
    expect(piProxyEndpoint('https://proxy.example/prefix///', 'space-1')).toBe(
      'https://proxy.example/prefix/pi/space-1/v1',
    );
  });

  it('runs the copied shell snippet with the matching extension, model and settings', () => {
    const base = 'https://proxy.example/prefix/';
    const model = "provider/model'2";
    const snippet = piProxySetup(base, 'space-1', model, '<user-key>');
    const stub = `
      pi() {
        printf '%s\\n' "$TDAI_PROXY_URL/$TDAI_AGENT_SOURCE/$TDAI_SPACE_ID/v1" \\
          "$TDAI_TEAM_ID" "$TDAI_AGENT_ID" "$TDAI_USER_KEY" "$TDAI_MODEL" "$@"
      }
    `;
    const output = execFileSync('bash', ['-e', '-c', `${stub}\n${snippet}`], { encoding: 'utf8' });

    expect(output.trimEnd().split('\n')).toEqual([
      piProxyEndpoint(base, 'space-1'),
      '<team-id>',
      '<agent-id>',
      '<user-key>',
      model,
      '-e',
      './MemoryCore/pi-plugin',
      '--provider',
      'tdai',
      '--model',
      model,
    ]);
  });
});
