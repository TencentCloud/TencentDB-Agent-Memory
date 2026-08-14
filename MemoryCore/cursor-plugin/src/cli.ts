import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolveCursorConfig, type CursorConfig } from "./config.js";
import { buildSessionContext } from "./context.js";
import { handleHook } from "./hooks.js";
import {
  installCursorAdapter,
  uninstallCursorAdapter,
  type CursorInstallOptions,
} from "./installer.js";
import { createCursorLogger } from "./logger.js";
import { runCursorMcpServer } from "./mcp.js";
import { appendTranscriptTurn } from "./pending.js";
import { runWorker, type WorkerOptions } from "./worker.js";

const HELP = `memory-tencentdb-cursor

Commands:
  hook [marker]                 Handle one Cursor Hook payload from stdin
  worker                        Drain pending captures once
  mcp                           Run the read-only stdio MCP bridge
  install --scope user|project  Safely install Hooks, MCP and Rule
  uninstall --scope user|project
`;

export interface CursorCliRuntime {
  readStdin: () => Promise<string>;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
  spawnDetached: (args: string[]) => void;
  runMcp: (config: CursorConfig) => Promise<void>;
  runWorker: (options: WorkerOptions) => Promise<void>;
  install: (options: CursorInstallOptions) => Promise<void>;
  uninstall: (options: CursorInstallOptions) => Promise<void>;
  appendTranscript: typeof appendTranscriptTurn;
  buildContext: (config: CursorConfig) => Promise<string | undefined>;
  log: (event: string, fields?: Record<string, unknown>) => void;
  env: Record<string, string | undefined>;
  home: string;
  cwd: string;
  executablePath: string;
  now: () => number;
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 10 * 1024 * 1024) throw new Error("stdin exceeds 10 MiB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createCursorCliRuntime(options: {
  executablePath?: string;
} = {}): CursorCliRuntime {
  const env = process.env;
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const executablePath =
    options.executablePath ?? process.argv[1] ?? "memory-tencentdb-cursor";
  const config = resolveCursorConfig(env, home, executablePath);
  const log = createCursorLogger(config.rootDir);

  return {
    readStdin: readProcessStdin,
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
    spawnDetached: (args) => {
      const child = spawn(executablePath, args, {
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      child.once("error", (error) => {
        log("detached_spawn_error", {
          error: error.message.slice(0, 300),
        });
      });
      child.unref();
    },
    runMcp: runCursorMcpServer,
    runWorker,
    install: installCursorAdapter,
    uninstall: uninstallCursorAdapter,
    appendTranscript: appendTranscriptTurn,
    buildContext: buildSessionContext,
    log,
    env,
    home,
    cwd: process.cwd(),
    executablePath,
    now: Date.now,
  };
}

function valueAfter(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseScope(args: string[]): "user" | "project" {
  const scope = valueAfter(args, "--scope");
  if (scope !== "user" && scope !== "project") {
    throw new Error("--scope must be user or project");
  }
  return scope;
}

function parsePayload(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Hook payload must be an object");
  }
  return parsed;
}

export async function main(
  args: string[],
  runtime: CursorCliRuntime,
): Promise<number> {
  const command = args[0];
  const config = resolveCursorConfig(
    runtime.env,
    runtime.home,
    runtime.executablePath,
  );

  if (!command || command === "--help" || command === "-h" || command === "help") {
    runtime.writeStdout(HELP);
    return 0;
  }

  if (command === "hook") {
    try {
      const payload = parsePayload(await runtime.readStdin());
      const result = await handleHook(payload, {
        rootDir: config.rootDir,
        transcriptsRoot: config.transcriptsRoot,
        appendTranscript: runtime.appendTranscript,
        spawnWorker: () => runtime.spawnDetached(["worker"]),
        buildContext: () => runtime.buildContext(config),
        log: runtime.log,
        now: runtime.now,
      });
      runtime.writeStdout(`${JSON.stringify(result)}\n`);
    } catch (error) {
      runtime.log("hook_input_error", {
        reason: error instanceof SyntaxError ? "invalid_json" : "invalid_payload",
      });
      runtime.writeStdout("{}\n");
    }
    return 0;
  }

  try {
    if (command === "worker") {
      if (args.length !== 1) throw new Error("worker does not accept arguments");
      await runtime.runWorker({ config, log: runtime.log });
      return 0;
    }
    if (command === "mcp") {
      if (args.length !== 1) throw new Error("mcp does not accept arguments");
      await runtime.runMcp(config);
      return 0;
    }
    if (command === "install" || command === "uninstall") {
      const scope = parseScope(args);
      const options = {
        scope,
        home: runtime.home,
        projectRoot: valueAfter(args, "--project-root") ?? runtime.cwd,
        executablePath: runtime.executablePath,
      };
      if (command === "install") await runtime.install(options);
      else await runtime.uninstall(options);
      runtime.writeStdout(`${command}ed Cursor Adapter in ${scope} scope\n`);
      return 0;
    }
    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    runtime.writeStderr(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}
