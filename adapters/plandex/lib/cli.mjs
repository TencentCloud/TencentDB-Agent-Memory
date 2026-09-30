import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  API_KEY_ENV_VAR,
  parseEnv,
  serializeCustomModels,
} from './config.mjs';
import { buildHealthUrl, getJson, postChatCompletion } from './http.mjs';

export const VERSION = '0.1.0';

export const USAGE = `tdai-plandex - TencentDB Agent Memory adapter for Plandex

Usage:
  tdai-plandex generate [--output <file>] [--dry-run] [--force]
  tdai-plandex check [--probe]
  tdai-plandex --help | --version

Commands:
  generate   Generate the Plandex custom-models JSON (provider + model + model pack).
             Without --output it prints to stdout; paste it into "plandex models custom".
  check      Verify the environment, MemoryProxy (:8096) and MemoryCore (:8420)
             health. --probe additionally performs a one-token chat round-trip.

Environment:
  TDAI_UPSTREAM_MODEL        required. Model id from PROXY_UPSTREAM_MODEL.
  TDAI_USER_KEY              business user key (sk-mem-...) from Memory Hub.
  TDAI_PROXY_BASE_URL        default http://127.0.0.1:8096
  TDAI_CORE_BASE_URL         default http://127.0.0.1:8420
  TDAI_SPACE_ID              memory instance id, default "default"

Exit codes:
  0  success
  1  validation, connectivity or probe failure
`;

export function parseArgs(argv) {
  const options = { dryRun: false, probe: false, force: false, output: null };
  let command = null;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      command = 'help';
      i += 1;
    } else if (arg === '--version') {
      command = 'version';
      i += 1;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
      i += 1;
    } else if (arg === '--probe') {
      options.probe = true;
      i += 1;
    } else if (arg === '--force') {
      options.force = true;
      i += 1;
    } else if (arg === '--output') {
      const value = argv[i + 1];
      if (!value) {
        return { command: null, options, error: '--output requires a file path' };
      }
      options.output = value;
      i += 2;
    } else if (arg.startsWith('-')) {
      return { command: null, options, error: `unknown option: ${arg}` };
    } else if (arg === 'generate' || arg === 'init') {
      command = 'generate';
      i += 1;
    } else if (arg === 'check' || arg === 'doctor') {
      command = 'check';
      i += 1;
    } else {
      return { command: null, options, error: `unknown command: ${arg}` };
    }
  }
  return { command: command ?? 'help', options };
}

export async function run(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const stdout = deps.stdout ?? console;
  const stderr = deps.stderr ?? console;

  const parsed = parseArgs(argv);
  if (parsed.error) {
    stderr.error(parsed.error);
    stderr.error(USAGE);
    return 1;
  }

  switch (parsed.command) {
    case 'help':
      stdout.log(USAGE);
      return 0;
    case 'version':
      stdout.log(`tdai-plandex ${VERSION}`);
      return 0;
    case 'generate':
      return generate(parsed.options, env, stdout, stderr);
    case 'check':
      return check(parsed.options, env, fetchImpl, stdout, stderr);
    default:
      stderr.error(USAGE);
      return 1;
  }
}

async function generate(options, env, stdout, stderr) {
  let cfg;
  try {
    cfg = parseEnv(env);
  } catch (error) {
    stderr.error(error.message);
    return 1;
  }

  const json = serializeCustomModels(cfg);
  if (options.dryRun) {
    stdout.log(json);
    return 0;
  }

  if (options.output) {
    try {
      if (!options.force) {
        try {
          await readFile(options.output);
          stderr.error(
            `refusing to overwrite ${options.output}; use --force to replace it`,
          );
          return 1;
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            throw error;
          }
        }
      }
      await mkdir(dirname(options.output), { recursive: true });
      await writeFile(options.output, json, 'utf8');
      stdout.log(`wrote ${options.output}`);
      stdout.log(
        `next: paste this file into "plandex models custom", then export ${API_KEY_ENV_VAR}=<sk-mem-...>`,
      );
      return 0;
    } catch (error) {
      stderr.error(`could not write ${options.output}: ${error.message}`);
      return 1;
    }
  }

  stdout.log(json);
  return 0;
}

async function check(options, env, fetchImpl, stdout, stderr) {
  let cfg;
  try {
    cfg = parseEnv(env);
  } catch (error) {
    stderr.error(error.message);
    return 1;
  }

  if (!cfg.userKey) {
    stderr.error(
      `${API_KEY_ENV_VAR} is required for check: export it to your business user key (sk-mem-...) from the Memory Hub.`,
    );
    return 1;
  }

  stdout.log(`model  ${cfg.upstreamModel}`);
  stdout.log(`space  ${cfg.spaceId}`);
  if (!/^sk-/i.test(cfg.userKey)) {
    stderr.error(
      `warning: ${API_KEY_ENV_VAR} does not look like a Memory user key (expected sk-mem-...); the probe may fail if this is an upstream API key.`,
    );
  }

  stdout.log(`proxy  ${cfg.proxyBaseUrl}`);
  const proxyHealth = await getJson(buildHealthUrl(cfg.proxyBaseUrl), { fetchImpl });
  if (!proxyHealth.ok) {
    stderr.error(
      `MemoryProxy is not reachable at ${buildHealthUrl(cfg.proxyBaseUrl)}: ${proxyHealth.error ?? `HTTP ${proxyHealth.status}`}`,
    );
    stderr.error(
      'hints: is deploy/global-images/start-all.sh running? MemoryProxy listens on :8096; check TDAI_PROXY_BASE_URL.',
    );
    return 1;
  }
  stdout.log('proxy health OK');

  stdout.log(`core   ${cfg.coreBaseUrl}`);
  const coreHealth = await getJson(buildHealthUrl(cfg.coreBaseUrl), { fetchImpl });
  if (!coreHealth.ok) {
    stderr.error(
      `MemoryCore is not reachable at ${buildHealthUrl(cfg.coreBaseUrl)}: ${coreHealth.error ?? `HTTP ${coreHealth.status}`}`,
    );
    stderr.error(
      'hints: MemoryCore listens on :8420; check TDAI_CORE_BASE_URL.',
    );
    return 1;
  }
  stdout.log('core health OK');

  if (options.probe) {
    const probe = await postChatCompletion({
      baseUrl: cfg.proxyBaseUrl,
      spaceId: cfg.spaceId,
      model: cfg.upstreamModel,
      apiKey: cfg.userKey,
      fetchImpl,
    });
    if (!probe.ok) {
      stderr.error(`chat probe failed: ${probe.error ?? `HTTP ${probe.status}`}`);
      stderr.error(
        'hints: TDAI_UPSTREAM_MODEL must match PROXY_UPSTREAM_MODEL and TDAI_USER_KEY must be a business user key.',
      );
      return 1;
    }
    stdout.log(
      `probe OK (model ${cfg.upstreamModel} via /proxy/${cfg.spaceId}/v1/chat/completions)`,
    );
  }

  stdout.log('check passed');
  return 0;
}
