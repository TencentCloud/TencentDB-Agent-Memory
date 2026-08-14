import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  batchMessages,
  buildImportPlan,
  checkpointKey,
  emptyCheckpoint,
  recordSuccessfulBatch,
  type ImportCheckpointV1,
  type ImportMessage,
  type ImportPlanV1,
  type MemorySource,
} from './plan.js';
import {
  defaultAgentHomes,
  scanClaude,
  scanCodex,
  scanWorkBuddy,
  type ScanResult,
} from './sources.js';

const DEFAULT_PANEL_URL = 'http://127.0.0.1:8123';
const DEFAULT_STATE_FILE = '.agent-memory-import-state.json';
const SUPPORTED_SOURCES = ['codex', 'workbuddy', 'codebuddy', 'claude', 'all'] as const;

interface CliOptions {
  source: string;
  teamId?: string;
  agentId?: string;
  codexHome: string;
  workbuddyHome: string;
  claudeHome: string;
  workspaces: string[];
  panelUrl: string;
  output?: string;
  stateFile: string;
  yes: boolean;
}

function usage(): string {
  return `Import generated memories from Codex, WorkBuddy/CodeBuddy, or Claude Code into Agent Memory L0.

Default mode is dry-run and never sends memory content.

Usage:
  pnpm import:agent-memory [options]

Options:
  --source NAME         codex | workbuddy | codebuddy | claude | all (default: all)
  --workspace PATH      Workspace to check for .workbuddy/memory (repeatable; default: cwd)
  --codex-home PATH     Codex home (default: CODEX_HOME or ~/.codex)
  --workbuddy-home PATH WorkBuddy/CodeBuddy user home (default: ~/.workbuddy)
  --claude-home PATH    Claude config home (default: CLAUDE_CONFIG_DIR or ~/.claude)
  --team-id ID          Target team (required with --yes)
  --agent-id ID         Target owning agent (required with --yes)
  --panel-url URL       MemoryPanel URL (default: ${DEFAULT_PANEL_URL})
  --output PATH         Write sensitive ImportPlan v1 JSON for review
  --state-file PATH     Successful batch checkpoint (default: ${DEFAULT_STATE_FILE})
  --yes                 Send the plan; the only remote-write switch
  --help                Show this help

Credentials are read only from TDAI_USER_KEY and TDAI_SERVICE_ID.`;
}

function optionsFromArgv(argv: string[]): CliOptions | undefined {
  const homes = defaultAgentHomes();
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      source: { type: 'string', default: 'all' },
      workspace: { type: 'string', multiple: true },
      'codex-home': { type: 'string', default: homes.codex },
      'workbuddy-home': { type: 'string', default: homes.workbuddy },
      'claude-home': { type: 'string', default: homes.claude },
      'team-id': { type: 'string' },
      'agent-id': { type: 'string' },
      'panel-url': { type: 'string', default: DEFAULT_PANEL_URL },
      output: { type: 'string' },
      'state-file': { type: 'string', default: DEFAULT_STATE_FILE },
      yes: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(usage());
    return undefined;
  }
  return {
    source: values.source ?? 'all',
    teamId: values['team-id'],
    agentId: values['agent-id'],
    codexHome: values['codex-home'] ?? homes.codex,
    workbuddyHome: values['workbuddy-home'] ?? homes.workbuddy,
    claudeHome: values['claude-home'] ?? homes.claude,
    workspaces: values.workspace?.length ? values.workspace : [process.cwd()],
    panelUrl: values['panel-url'] ?? DEFAULT_PANEL_URL,
    output: values.output,
    stateFile: values['state-file'] ?? DEFAULT_STATE_FILE,
    yes: values.yes ?? false,
  };
}

function selectedSources(value: string): MemorySource[] {
  if (!(SUPPORTED_SOURCES as readonly string[]).includes(value)) {
    throw new Error(`Unsupported source: ${value}`);
  }
  if (value === 'all') return ['codex', 'workbuddy', 'claude'];
  if (value === 'codebuddy') return ['workbuddy'];
  return [value as MemorySource];
}

async function scan(options: CliOptions): Promise<ScanResult> {
  const selected = selectedSources(options.source);
  const results = await Promise.all(selected.map((source) => {
    if (source === 'codex') return scanCodex(options.codexHome);
    if (source === 'workbuddy') return scanWorkBuddy(options.workbuddyHome, options.workspaces);
    return scanClaude(options.claudeHome);
  }));
  return {
    documents: results.flatMap((result) => result.documents),
    reports: results.flatMap((result) => result.reports),
  };
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readCheckpoint(path: string): Promise<ImportCheckpointV1> {
  const raw = await readOptional(path);
  if (!raw) return emptyCheckpoint();
  const parsed = JSON.parse(raw) as Partial<ImportCheckpointV1>;
  if (
    parsed.version !== 1
    || !parsed.completed
    || typeof parsed.completed !== 'object'
    || Array.isArray(parsed.completed)
  ) {
    throw new Error(`Unsupported checkpoint format: ${path}`);
  }
  return parsed as ImportCheckpointV1;
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const absolute = resolve(path);
  const temporary = join(dirname(absolute), `.${process.pid}-${Date.now()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, absolute);
  await chmod(absolute, 0o600);
}

function printPlan(plan: ImportPlanV1, result: ScanResult, options: CliOptions): void {
  console.log(`Scanning generated memories (${options.yes ? 'write enabled' : 'dry-run; no remote writes'}):\n`);
  for (const report of result.reports) {
    console.log(`  ${report.source.padEnd(10)} files=${report.files} locations=${report.locations}`);
    for (const note of report.notes) console.log(`    - ${note}`);
  }
  const messageCount = plan.sessions.reduce((sum, session) => sum + session.messages.length, 0);
  const batchCount = plan.sessions.reduce((sum, session) => sum + batchMessages(session.messages).length, 0);
  const messageLengths = plan.sessions.flatMap((session) => {
    return session.messages.map((message) => message.content.length);
  });
  const maxMessageChars = Math.max(0, ...messageLengths);
  console.log(
    `\nPlan: version=1 sources=${plan.sources.join(',')} sessions=${plan.sessions.length} `
      + `messages=${messageCount} batches=${batchCount} max_message_chars=${maxMessageChars}`,
  );
  if (options.teamId || options.agentId) {
    console.log(`Target: team=${options.teamId ?? '(not set)'} agent=${options.agentId ?? '(not set)'}`);
  }
}

interface PanelEnvelope {
  code: number;
  message?: string;
  data?: { accepted_count?: number };
}

async function importBatch(
  options: CliOptions,
  sessionId: string,
  messages: ImportMessage[],
  userKey: string,
  serviceId: string,
): Promise<number> {
  const endpoint = new URL('/api/v1/chat-memory/import', `${options.panelUrl.replace(/\/+$/, '')}/`);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tdai-Service-Id': serviceId,
        'X-Tdai-User-Key': userKey,
      },
      body: JSON.stringify({
        team_id: options.teamId,
        agent_id: options.agentId,
        session_id: sessionId,
        messages,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(
      `Import outcome is unknown after a network failure (${error instanceof Error ? error.message : String(error)}). `
        + 'The batch was not checkpointed; inspect the target before rerunning.',
    );
  }

  let envelope: PanelEnvelope;
  try {
    envelope = (await response.json()) as PanelEnvelope;
  } catch {
    throw new Error(
      `Import outcome is unknown because MemoryPanel returned a non-JSON response (HTTP ${response.status}). `
        + 'The batch was not checkpointed; inspect the target before rerunning.',
    );
  }
  if (!response.ok || envelope.code !== 0) {
    throw new Error(
      `MemoryPanel rejected the batch (HTTP ${response.status}, code ${envelope.code}): `
        + (envelope.message ?? 'unknown error'),
    );
  }
  if (typeof envelope.data?.accepted_count !== 'number') {
    throw new Error(
      'Import outcome is unknown because MemoryPanel omitted accepted_count; inspect the target before rerunning.',
    );
  }
  return envelope.data.accepted_count;
}

export async function run(argv = process.argv.slice(2)): Promise<void> {
  const options = optionsFromArgv(argv);
  if (!options) return;
  const result = await scan(options);
  const plan = buildImportPlan(result.documents);
  printPlan(plan, result, options);
  if (!plan.sessions.length) throw new Error('No supported generated memories were found');

  if (options.output) {
    if (resolve(options.output) === resolve(options.stateFile)) {
      throw new Error('--output and --state-file must use different paths');
    }
    await writePrivateJson(options.output, plan);
    console.log(`Import Plan written with mode 0600: ${resolve(options.output)}`);
    console.log('Warning: the plan contains memory content and must be handled as sensitive data.');
  }
  if (!options.yes) {
    console.log('Run again with --yes to import. Parsing uses no LLM; Agent Memory distillation is asynchronous.');
    return;
  }
  if (!options.teamId || !options.agentId) throw new Error('--team-id and --agent-id are required with --yes');
  const userKey = process.env.TDAI_USER_KEY;
  if (!userKey) throw new Error('TDAI_USER_KEY is required with --yes');
  const serviceId = process.env.TDAI_SERVICE_ID || 'default';

  const statePath = resolve(options.stateFile);
  let checkpoint = await readCheckpoint(statePath);
  let imported = 0;
  let skipped = 0;
  for (const session of plan.sessions) {
    const batches = batchMessages(session.messages);
    for (const [index, batch] of batches.entries()) {
      const key = checkpointKey({ teamId: options.teamId, agentId: options.agentId }, session.session_id, batch);
      const completed = checkpoint.completed[key];
      if (completed && completed.accepted_count !== batch.length) {
        throw new Error(`Checkpoint entry does not match batch length for ${session.session_id}`);
      }
      if (completed) {
        skipped += batch.length;
        console.log(`Skip completed ${session.source} batch ${index + 1}/${batches.length}`);
        continue;
      }
      console.log(`Import ${session.source} batch ${index + 1}/${batches.length} (${batch.length} messages)`);
      const acceptedCount = await importBatch(options, session.session_id, batch, userKey, serviceId);
      checkpoint = recordSuccessfulBatch(checkpoint, key, batch.length, acceptedCount);
      try {
        await writePrivateJson(statePath, checkpoint);
      } catch (error) {
        throw new Error(
          `Batch imported but checkpoint write failed (${error instanceof Error ? error.message : String(error)}); `
            + 'inspect the target and state file before rerunning.',
        );
      }
      imported += acceptedCount;
    }
  }
  console.log(`Import complete: imported=${imported} skipped_from_checkpoint=${skipped}`);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
