import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CursorConfig } from "../../MemoryCore/cursor-plugin/src/config.js";
import { buildSessionContext } from "../../MemoryCore/cursor-plugin/src/context.js";
import { handleHook } from "../../MemoryCore/cursor-plugin/src/hooks.js";
import { runWorker } from "../../MemoryCore/cursor-plugin/src/worker.js";

export const PERSONA_MARKER = "VERIFY-PERSONA-MARKER";
export const SCENE_PATH = "memory-effect/scene.md";

export interface HookRunLog {
  event: string;
  fields?: Record<string, unknown>;
}

export interface MemoryEffectSandbox {
  root: string;
  cursorRoot: string;
  projectsRoot: string;
  config: CursorConfig;
  token: string;
  rememberPrompt: string;
  dispose: () => Promise<void>;
}

export function makeToken(): string {
  return `MEMFX-${Date.now().toString(36).toUpperCase()}-${Math.random()
    .toString(36).slice(2, 8).toUpperCase()}`;
}

export async function createTempSandbox(
  gatewayUrl: string,
): Promise<MemoryEffectSandbox> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cursor-v3-memfx-"));
  const cursorRoot = path.join(root, "cursor");
  const projectsRoot = path.join(root, ".cursor", "projects");
  await mkdir(path.join(cursorRoot, "pending"), { recursive: true });
  await mkdir(path.join(cursorRoot, "sessions"), { recursive: true });
  await mkdir(projectsRoot, { recursive: true });
  const token = makeToken();

  return {
    root,
    cursorRoot,
    projectsRoot,
    token,
    rememberPrompt: `请记住：我的构建口令是 ${token}。`,
    config: {
      rootDir: cursorRoot,
      gatewayUrl,
      gatewayApiKey: "test-api-key",
      serviceId: "service-1",
      teamId: "team-1",
      agentId: "agent-1",
      userId: "user-1",
      taskId: "task-1",
      captureTimeoutMs: 2_000,
      recallTimeoutMs: 2_000,
      executablePath: "/bin/memory-tencentdb-cursor",
      transcriptsRoot: projectsRoot,
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

export async function writeClosedTranscript(options: {
  projectsRoot: string;
  conversationId: string;
  userText: string;
  assistantText: string;
}): Promise<string> {
  const transcriptDir = path.join(
    options.projectsRoot,
    "memory-effect",
    "agent-transcripts",
    options.conversationId,
  );
  await mkdir(transcriptDir, { recursive: true });
  const transcriptPath = path.join(transcriptDir, `${options.conversationId}.jsonl`);
  const body = [
    JSON.stringify({
      role: "user",
      message: { content: [{ type: "text", text: `<user_query>\n${options.userText}\n</user_query>` }] },
    }),
    JSON.stringify({
      role: "assistant",
      message: { content: [{ type: "text", text: options.assistantText }] },
    }),
    JSON.stringify({ type: "turn_ended", status: "success" }),
  ].join("\n");
  await writeFile(transcriptPath, `${body}\n`);
  return transcriptPath;
}

export async function listPendingFiles(cursorRoot: string): Promise<string[]> {
  return readdir(path.join(cursorRoot, "pending"))
    .then((names) => names.filter((name) => name.endsWith(".jsonl")).sort())
    .catch(() => []);
}

export async function readPendingBodies(cursorRoot: string): Promise<string[]> {
  const names = await listPendingFiles(cursorRoot);
  return Promise.all(names.map((name) =>
    readFile(path.join(cursorRoot, "pending", name), "utf8")));
}

export async function runSessionStart(
  sandbox: MemoryEffectSandbox,
  conversationId: string,
  log: HookRunLog[] = [],
): Promise<Record<string, unknown>> {
  return handleHook({
    hook_event_name: "sessionStart",
    conversation_id: conversationId,
    is_background_agent: false,
  }, {
    rootDir: sandbox.cursorRoot,
    transcriptsRoot: sandbox.projectsRoot,
    spawnWorker: () => undefined,
    buildContext: () => buildSessionContext(sandbox.config),
    log: (event, fields) => log.push({ event, fields }),
  });
}

export async function runStopCapture(
  sandbox: MemoryEffectSandbox,
  options: {
    conversationId: string;
    generationId: string;
    transcriptPath: string;
  },
  log: HookRunLog[] = [],
  spawned: { count: number } = { count: 0 },
): Promise<Record<string, unknown>> {
  return handleHook({
    hook_event_name: "stop",
    conversation_id: options.conversationId,
    generation_id: options.generationId,
    transcript_path: options.transcriptPath,
    status: "completed",
  }, {
    rootDir: sandbox.cursorRoot,
    transcriptsRoot: sandbox.projectsRoot,
    spawnWorker: () => { spawned.count += 1; },
    buildContext: async () => undefined,
    log: (event, fields) => log.push({ event, fields }),
  });
}

export async function drainWorker(
  sandbox: MemoryEffectSandbox,
  log: HookRunLog[] = [],
): Promise<void> {
  await runWorker({
    config: sandbox.config,
    log: (event, fields) => log.push({ event, fields }),
  });
}

async function readRequestBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

export interface FakeMemoryRequest {
  path: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

export async function startFakeMemoryV3(): Promise<{
  url: string;
  requests: FakeMemoryRequest[];
  close: () => Promise<void>;
}> {
  const requests: FakeMemoryRequest[] = [];
  const server: Server = createServer(async (req, res) => {
    const requestPath = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const body = await readRequestBody(req);
    requests.push({ path: requestPath, headers: req.headers, body });

    let data: Record<string, unknown>;
    if (requestPath === "/v3/core/read") {
      data = {
        content: `${PERSONA_MARKER}\n构建口令保存在会话记忆中。`,
        created_at: null,
        updated_at: null,
      };
    } else if (requestPath === "/v3/scenario/ls") {
      data = {
        entries: [{ path: SCENE_PATH, created_at: "", updated_at: "" }],
        total: 1,
      };
    } else if (requestPath === "/v3/conversation/add") {
      data = { accepted_ids: ["m1", "m2"], total_count: 2 };
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 404, message: "not found", request_id: "req-404" }));
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 0, message: "ok", request_id: "req-1", data }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake v3 server bind failed");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
  };
}
