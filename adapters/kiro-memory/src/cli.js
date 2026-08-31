import { resolveConfig } from './core/config.js';
import { pathToFileURL } from 'node:url';
import { KiroIdeHookAssistantProvider } from './core/assistant-response-provider.js';
import { CaptureService } from './core/capture-service.js';
import { ArchiveService } from './core/archive-service.js';
import { normalizeHookEvent } from './core/event-normalizer.js';
import { GatewayClient } from './core/gateway-client.js';
import { Outbox } from './core/outbox.js';
import { RecallService } from './core/recall-service.js';
import { UnifiedQueryService } from './core/query-service.js';
import { TurnStore } from './core/turn-store.js';
import { handlePostToolUse } from './hooks/post-tool-use.js';
import { handlePromptSubmit } from './hooks/prompt-submit.js';
import { handleStop } from './hooks/stop.js';

const MAX_STDIN_BYTES = 4 * 1024 * 1024;
const expectedEvent = { recall: 'UserPromptSubmit', 'post-tool-use': 'PostToolUse', stop: 'Stop' };
const safe = () => ({ exitCode: 0, stdout: '' });
const defaultLoadConfig = async (env, workspace) => (await resolveConfig({ env, workspace })).config;

const defaultDependencies = (config) => {
  const gatewayClient = new GatewayClient(config);
  const queryService = new UnifiedQueryService({ gatewayClient });
  let archiveService;
  const outbox = new Outbox({
    stateDir: config.stateDir,
    gatewayClient,
    shouldProcess: async (item) => !archiveService || archiveService.isForceOperationCurrent(item),
    onAcknowledged: async (item, response) => {
      if (!archiveService) return;
      if (item.version === 2 && item.operation_type === 'force_archive') {
        await archiveService.recordForceOutcome({
          sessionId: item.session_id,
          archiveGeneration: item.archive_generation,
          response,
        });
        return;
      }
      if (['ok', 'archived'].includes(response?.status)) {
        await archiveService.recordCaptureOutcome({
          sessionId: item.session_id,
          captureId: item.operation_id ?? item.capture_id,
          response,
        });
      }
    },
  });
  const turnStore = new TurnStore({ stateDir: config.stateDir });
  archiveService = new ArchiveService({ config, turnStore, outbox });
  return {
    outbox,
    turnStore,
    archiveService,
    recallService: new RecallService({ queryService, config }),
    captureService: new CaptureService({ config, gatewayClient, outbox, archiveService }),
    assistantResponseProvider: new KiroIdeHookAssistantProvider(),
  };
};

const readInput = async (stdin) => {
  if (typeof stdin === 'string') {
    if (Buffer.byteLength(stdin, 'utf8') > MAX_STDIN_BYTES) throw new Error('input');
    return stdin;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > MAX_STDIN_BYTES) throw new Error('input');
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
};

export async function runCli({
  argv = process.argv.slice(2), stdin = process.stdin, env = process.env,
  loadConfig = defaultLoadConfig, createDependencies = defaultDependencies,
} = {}) {
  try {
    if (!Array.isArray(argv) || argv.length !== 1 || !Object.hasOwn(expectedEvent, argv[0])) return safe();
    const raw = JSON.parse(await readInput(stdin));
    const event = normalizeHookEvent(raw);
    const command = argv[0];
    if (event.eventName !== expectedEvent[command]) return safe();
    const config = await loadConfig(env, event.cwd);
    const dependencies = createDependencies(config);
    try { await dependencies.outbox.flush({ maxItems: 3, budgetMs: 1500 }); } catch { /* fail open */ }
    try { await dependencies.archiveService?.considerSessionIdle(event.sessionId); } catch { /* fail open */ }

    if (config.captureEnabled === false) {
      if (command !== 'recall') return safe();
      try { return { exitCode: 0, stdout: await dependencies.recallService.recall(event.prompt) || '' }; } catch { return safe(); }
    }
    if (command === 'recall') {
      const result = await handlePromptSubmit(event, { turnStore: dependencies.turnStore, recallService: dependencies.recallService });
      return { exitCode: 0, stdout: result.stdout || '' };
    }
    if (command === 'post-tool-use') {
      await handlePostToolUse(event, { turnStore: dependencies.turnStore });
      return safe();
    }
    await handleStop(event, {
      turnStore: dependencies.turnStore,
      captureService: dependencies.captureService,
      assistantResponseProvider: dependencies.assistantResponseProvider,
    });
    return safe();
  } catch {
    return safe();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runCli();
  if (result.stdout) process.stdout.write(result.stdout);
  process.exitCode = result.exitCode;
}
