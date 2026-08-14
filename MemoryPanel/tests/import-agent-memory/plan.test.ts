import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { run } from '../../scripts/import-agent-memory/cli.js';
import {
  MAX_MESSAGE_CHARS,
  batchMessages,
  buildImportPlan,
  checkpointKey,
  emptyCheckpoint,
  recordSuccessfulBatch,
  type MemoryDocument,
} from '../../scripts/import-agent-memory/plan.js';
import {
  scanCodex,
  scanClaude,
  scanWorkBuddy,
} from '../../scripts/import-agent-memory/sources.js';

describe('multi-source ImportPlan v1', () => {
  it('normalizes Codex, WorkBuddy/CodeBuddy, and Claude Code without assistant messages', () => {
    const documents: MemoryDocument[] = [
      {
        source: 'codex',
        sourceLabel: 'memory_summary.md',
        content: 'v1\n\n## Profile\nFact A\n\n## Preferences\nFact B',
        split: 'h2',
      },
      {
        source: 'codex',
        sourceLabel: 'MEMORY.md',
        content: '# Task Group: Alpha\nKnowledge A',
        split: 'codex-task-group',
      },
      {
        source: 'workbuddy',
        sourceLabel: 'workspace/demo/memory/2026-08-14.md',
        content: '# Work log\n\n## Topic\nConclusion',
        split: 'h2',
      },
      {
        source: 'claude',
        sourceLabel: 'project-demo/debugging.md',
        content: '# Debugging\nUse pnpm for this project.',
        split: 'h2',
      },
    ];
    const plan = buildImportPlan(documents);

    expect(plan.sources).toEqual(['codex', 'workbuddy', 'claude']);
    expect(plan.sessions.map((session) => session.source)).toEqual([
      'codex',
      'codex',
      'codex',
      'workbuddy',
      'claude',
    ]);
    expect(plan.sessions[0]?.messages).toHaveLength(1);
    expect(plan.sessions.flatMap((session) => session.messages).every((message) => message.role === 'user')).toBe(true);
    expect(plan.sessions[3]?.messages[0]?.content).toContain('[Imported memory: workbuddy/');
    expect(plan.sessions[4]?.messages[0]?.content).toContain('[Imported memory: claude/');
  });

  it('keeps an empty scan empty', () => {
    expect(buildImportPlan([])).toEqual({ version: 1, sources: [], sessions: [] });
  });

  it('splits oversized blocks and keeps every L0 message within the Core limit', () => {
    const payload = 'x'.repeat(MAX_MESSAGE_CHARS * 2);
    const plan = buildImportPlan([{
      source: 'claude',
      sourceLabel: 'project-demo/large.md',
      content: payload,
      split: 'h2',
    }]);
    const messages = plan.sessions[0]?.messages ?? [];

    expect(messages.length).toBeGreaterThan(2);
    expect(messages.every((message) => message.content.length <= MAX_MESSAGE_CHARS)).toBe(true);
    expect(messages[0]?.content).toContain('[part 1/');
    const importedBodyChars = messages.reduce((sum, message) => {
      return sum + message.content.slice(message.content.indexOf('\n\n') + 2).length;
    }, 0);
    expect(importedBodyChars).toBe(payload.length);
  });

  it('paginates the 101st message instead of dropping it', () => {
    expect(batchMessages(Array.from({ length: 100 }, (_, index) => index))).toHaveLength(1);
    expect(
      batchMessages(Array.from({ length: 101 }, (_, index) => index)).map((batch) => batch.length),
    ).toEqual([100, 1]);
    const content = 'x'.repeat(MAX_MESSAGE_CHARS * 101);
    const plan = buildImportPlan([{
      source: 'workbuddy',
      sourceLabel: 'workspace/demo/memory/log.md',
      content,
      split: 'h2',
    }]);
    expect(plan.sessions).toHaveLength(1);
    const batches = batchMessages(plan.sessions[0]?.messages ?? []);
    expect(batches.map((batch) => batch.length)).toEqual([100, 2]);
    expect(batches.flat()).toHaveLength(102);
  });

  it('checkpoints only a fully accepted batch and scopes resume keys to the target', () => {
    const batch = [{ role: 'user' as const, content: 'memory' }];
    const target = {
      endpoint: 'http://panel-a/api/v1/chat-memory/import',
      serviceId: 'default',
      teamId: 'team-a',
      agentId: 'agent-a',
    };
    const key = checkpointKey(target, 'session-a', batch);
    const otherTargetKey = checkpointKey({ ...target, agentId: 'agent-b' }, 'session-a', batch);
    const otherPanelKey = checkpointKey({ ...target, endpoint: 'http://panel-b/api/v1/chat-memory/import' }, 'session-a', batch);
    const otherServiceKey = checkpointKey({ ...target, serviceId: 'service-b' }, 'session-a', batch);
    expect(otherTargetKey).not.toBe(key);
    expect(otherPanelKey).not.toBe(key);
    expect(otherServiceKey).not.toBe(key);
    expect(() => recordSuccessfulBatch(emptyCheckpoint(), key, 1, 0)).toThrow('accepted 0/1');

    const state = recordSuccessfulBatch(emptyCheckpoint(), key, 1, 1, '2026-08-14T00:00:00.000Z');
    expect(state.completed[key]).toEqual({ accepted_count: 1, imported_at: '2026-08-14T00:00:00.000Z' });
  });

  it('keeps session ids deterministic without embedding source filesystem paths', () => {
    const document: MemoryDocument = {
      source: 'workbuddy',
      sourceLabel: 'workspace/demo/MEMORY.md',
      content: '## Stable\nFact',
      split: 'h2',
    };
    const first = buildImportPlan([document]);
    const second = buildImportPlan([document]);
    expect(first.sessions[0]?.session_id).toBe(second.sessions[0]?.session_id);
    expect(first.sessions[0]?.session_id).toMatch(/^import-workbuddy-[0-9a-f]{16}$/);
  });

  it('reimports only a changed H2 section', () => {
    const original = buildImportPlan([{
      source: 'codex',
      sourceLabel: 'memory_summary.md',
      content: 'v1\n\n## Profile\nFact A\n\n## Preferences\nFact B',
      split: 'h2',
    }]);
    const changed = buildImportPlan([{
      source: 'codex',
      sourceLabel: 'memory_summary.md',
      content: 'v1\n\n## Profile\nFact A\n\n## Preferences\nFact C',
      split: 'h2',
    }]);

    expect(changed.sessions.map((session) => session.session_id)).toEqual(
      original.sessions.map((session) => session.session_id),
    );
    expect(changed.sessions[0]?.messages).toEqual(original.sessions[0]?.messages);
    expect(changed.sessions[1]?.messages).not.toEqual(original.sessions[1]?.messages);
  });
});

describe('source scanners', () => {
  it('scans WorkBuddy and CodeBuddy shared user/workspace memory layout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbuddy-import-'));
    const home = join(root, 'home');
    const workspace = join(root, 'demo-workspace');
    try {
      await mkdir(join(workspace, '.workbuddy', 'memory'), { recursive: true });
      await mkdir(home);
      await writeFile(join(home, 'MEMORY.md'), '## User memory\nPreference');
      await writeFile(join(workspace, '.workbuddy', 'memory', 'MEMORY.md'), '## Project memory\nDecision');
      await writeFile(join(workspace, '.workbuddy', 'memory', '2026-08-14.md'), '## Work log\nOutcome');

      const result = await scanWorkBuddy(home, [workspace]);
      expect(result.documents).toHaveLength(3);
      expect(result.documents.every((document) => document.source === 'workbuddy')).toBe(true);
      expect(JSON.stringify(result.documents.map((document) => document.sourceLabel))).not.toContain(root);
      expect(result.documents.map((document) => document.sourceLabel)).toContain(
        'workspace/demo-workspace/MEMORY.md',
      );
      expect(result.reports[0]).toMatchObject({ source: 'workbuddy', files: 3, locations: 2 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('scans Claude project MEMORY.md and topic files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-import-'));
    const memory = join(root, 'projects', 'encoded-project-name', 'memory');
    try {
      await mkdir(memory, { recursive: true });
      await writeFile(join(memory, 'MEMORY.md'), '# Index\n- See debugging.md');
      await writeFile(join(memory, 'debugging.md'), '## Debugging\nUse pnpm');

      const result = await scanClaude(root);
      expect(result.documents).toHaveLength(2);
      expect(result.documents.every((document) => document.source === 'claude')).toBe(true);
      const labels = JSON.stringify(result.documents.map((document) => document.sourceLabel));
      expect(labels).not.toContain('encoded-project-name');
      expect(result.reports[0]).toMatchObject({ source: 'claude', files: 2, locations: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('honors Claude user-level autoMemoryDirectory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-custom-import-'));
    const custom = join(root, 'custom-memory');
    try {
      await mkdir(custom);
      await writeFile(join(root, 'settings.json'), JSON.stringify({ autoMemoryDirectory: custom }));
      await writeFile(join(custom, 'MEMORY.md'), '# Custom index');

      const result = await scanClaude(root);
      expect(result.documents.map((document) => document.sourceLabel)).toEqual(['custom/MEMORY.md']);
      expect(result.reports[0]?.notes).toContain('user autoMemoryDirectory checked');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('continues with default Claude projects when settings JSON is invalid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-invalid-settings-'));
    const memory = join(root, 'projects', 'project-a', 'memory');
    try {
      await mkdir(memory, { recursive: true });
      await writeFile(join(root, 'settings.json'), '{invalid');
      await writeFile(join(memory, 'MEMORY.md'), '## Default\nStill scanned');

      const result = await scanClaude(root);
      expect(result.documents.map((document) => document.sourceLabel)).toEqual(['project-1/MEMORY.md']);
      expect(result.reports[0]?.notes).toContain(
        'settings.json is invalid JSON; scanning default project memories instead',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not scan adjacent Codex raw or ad-hoc data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-privacy-boundary-'));
    const memories = join(root, 'memories');
    try {
      await mkdir(join(root, 'sessions'), { recursive: true });
      await mkdir(join(memories, 'rollout_summaries'), { recursive: true });
      await mkdir(join(memories, 'extensions', 'ad_hoc'), { recursive: true });
      await writeFile(join(memories, 'memory_summary.md'), '## Safe\nGenerated memory');
      await writeFile(join(root, 'sessions', 'raw.jsonl'), 'PRIVATE RAW SESSION');
      await writeFile(join(memories, 'rollout_summaries', 'raw.md'), 'PRIVATE ROLLOUT');
      await writeFile(join(memories, 'extensions', 'ad_hoc', 'note.md'), 'PRIVATE AD HOC');
      await writeFile(join(memories, 'memories.sqlite'), 'PRIVATE DATABASE');

      const result = await scanCodex(root);
      expect(result.documents.map((document) => document.sourceLabel)).toEqual(['memory_summary.md']);
      expect(JSON.stringify(result.documents)).not.toMatch(/PRIVATE RAW|PRIVATE ROLLOUT|PRIVATE AD HOC|PRIVATE DATABASE/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('CLI resume', () => {
  it('writes a checkpoint after full acceptance and skips the batch on resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-memory-import-'));
    const memories = join(root, 'memories');
    const stateFile = join(root, 'state.json');
    await mkdir(memories);
    await writeFile(join(memories, 'MEMORY.md'), '# Task Group: Resume\nOne fact');
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ code: 0, data: { accepted_count: 1 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const previousUserKey = process.env.TDAI_USER_KEY;
    const previousServiceId = process.env.TDAI_SERVICE_ID;
    process.env.TDAI_USER_KEY = 'test-user-key';
    delete process.env.TDAI_SERVICE_ID;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const args = [
      '--source', 'codex',
      '--codex-home', root,
      '--team-id', 'team-a',
      '--agent-id', 'agent-a',
      '--panel-url', 'http://example.invalid',
      '--state-file', stateFile,
      '--yes',
    ];

    try {
      await run(args);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [requestUrl, requestInit] = fetchMock.mock.calls[0] ?? [];
      expect(String(requestUrl)).toBe('http://example.invalid/api/v1/chat-memory/import');
      expect(requestInit?.method).toBe('POST');
      expect(requestInit?.headers).toMatchObject({
        'Content-Type': 'application/json',
        'X-Tdai-Service-Id': 'default',
        'X-Tdai-User-Key': 'test-user-key',
      });
      const requestBody = JSON.parse(String(requestInit?.body)) as {
        team_id: string;
        agent_id: string;
        session_id: string;
        messages: Array<{ role: string; content: string }>;
      };
      expect(requestBody).toMatchObject({ team_id: 'team-a', agent_id: 'agent-a' });
      expect(requestBody.session_id).toMatch(/^import-codex-[0-9a-f]{16}$/);
      expect(requestBody.messages).toHaveLength(1);
      expect(requestBody.messages[0]).toMatchObject({ role: 'user' });
      expect(requestBody.messages[0]?.content).toContain('[Imported memory: codex/');

      await run(args);
      const state = JSON.parse(await readFile(stateFile, 'utf8')) as { completed: object };
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(Object.keys(state.completed)).toHaveLength(1);
      if (process.platform !== 'win32') expect((await stat(stateFile)).mode & 0o777).toBe(0o600);

      const otherPanelArgs = [...args];
      otherPanelArgs[otherPanelArgs.indexOf('http://example.invalid')] = 'http://other.invalid';
      await run(otherPanelArgs);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      process.env.TDAI_SERVICE_ID = 'service-b';
      await run(otherPanelArgs);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(Object.keys((JSON.parse(await readFile(stateFile, 'utf8')) as { completed: object }).completed)).toHaveLength(3);
    } finally {
      if (previousUserKey === undefined) delete process.env.TDAI_USER_KEY;
      else process.env.TDAI_USER_KEY = previousUserKey;
      if (previousServiceId === undefined) delete process.env.TDAI_SERVICE_ID;
      else process.env.TDAI_SERVICE_ID = previousServiceId;
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to checkpoint an API response without accepted_count', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-memory-import-contract-'));
    const memories = join(root, 'memories');
    const stateFile = join(root, 'state.json');
    await mkdir(memories);
    await writeFile(join(memories, 'MEMORY.md'), '# Task Group: Contract\nOne fact');
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ code: 0, data: { imported: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));
    const previousUserKey = process.env.TDAI_USER_KEY;
    const previousServiceId = process.env.TDAI_SERVICE_ID;
    process.env.TDAI_USER_KEY = 'test-user-key';
    delete process.env.TDAI_SERVICE_ID;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await expect(run([
        '--source', 'codex',
        '--codex-home', root,
        '--team-id', 'team-a',
        '--agent-id', 'agent-a',
        '--panel-url', 'http://example.invalid',
        '--state-file', stateFile,
        '--yes',
      ])).rejects.toThrow('omitted accepted_count');
      await expect(readFile(stateFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (previousUserKey === undefined) delete process.env.TDAI_USER_KEY;
      else process.env.TDAI_USER_KEY = previousUserKey;
      if (previousServiceId === undefined) delete process.env.TDAI_SERVICE_ID;
      else process.env.TDAI_SERVICE_ID = previousServiceId;
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('treats a JSON HTTP 500 as an unknown write outcome', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-memory-import-500-'));
    const memories = join(root, 'memories');
    const stateFile = join(root, 'state.json');
    await mkdir(memories);
    await writeFile(join(memories, 'MEMORY.md'), '# Task Group: Failure\nOne fact');
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ code: 500, message: 'internal error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));
    const previousUserKey = process.env.TDAI_USER_KEY;
    const previousServiceId = process.env.TDAI_SERVICE_ID;
    process.env.TDAI_USER_KEY = 'test-user-key';
    delete process.env.TDAI_SERVICE_ID;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await expect(run([
        '--source', 'codex',
        '--codex-home', root,
        '--team-id', 'team-a',
        '--agent-id', 'agent-a',
        '--panel-url', 'http://example.invalid',
        '--state-file', stateFile,
        '--yes',
      ])).rejects.toThrow('outcome is unknown');
      await expect(readFile(stateFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (previousUserKey === undefined) delete process.env.TDAI_USER_KEY;
      else process.env.TDAI_USER_KEY = previousUserKey;
      if (previousServiceId === undefined) delete process.env.TDAI_SERVICE_ID;
      else process.env.TDAI_SERVICE_ID = previousServiceId;
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });
});
