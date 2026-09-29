import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createMockBridge } from "./fixtures.js";
import { parseCurlArgs, shellWords } from "./protocol.js";
import type { EvalCase, ParsedCall, RunRecord, WorkspacePythonRuntime } from "./types.js";

export interface WorkspaceHostOptions {
  /** Absolute interpreter path. Falls back to TOOL_ROUTING_PYTHON_EXECUTABLE; unset preserves PATH behavior. */
  pythonExecutable?: string;
  /** Required major.minor or major.minor.patch, for example 3.14. */
  pythonVersion?: string;
  /** Freeze once for a run, then validate every workspace against this identity. */
  expectedPythonRuntime?: WorkspacePythonRuntime;
}

const systemPath = `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin`;
const pythonProbe = `import json, os, sys, sysconfig
print(json.dumps({"executable": os.path.realpath(sys.executable), "version": sys.version,
 "version_info": list(sys.version_info[:3]), "implementation": sys.implementation.name,
 "prefix": os.path.realpath(sys.prefix), "base_prefix": os.path.realpath(sys.base_prefix),
 "stdlib": os.path.realpath(sysconfig.get_path("stdlib"))}))`;

function probePython(executable: string, profile?: string): Omit<WorkspacePythonRuntime, "executable_sha256"> {
  const args = ["-I", "-S", "-c", pythonProbe];
  const result = spawnSync(profile ? "/usr/bin/sandbox-exec" : executable,
    profile ? ["-p", profile, executable, ...args] : args,
    { encoding: "utf8", timeout: 10_000, maxBuffer: 65_536, env: { PATH: systemPath, LANG: "en_US.UTF-8" } });
  if (result.error || result.status !== 0) {
    throw new Error(`Python runtime cannot execute${profile ? " in workspace sandbox" : ""}: ${executable}: ${result.error?.message ?? result.stderr.trim()}`);
  }
  let runtime: ReturnType<typeof probePython>;
  try { runtime = JSON.parse(result.stdout); } catch { throw new Error(`Python runtime returned an invalid identity: ${executable}`); }
  if (runtime.executable !== executable || runtime.version_info?.length !== 3 || runtime.version_info[0] !== 3
    || !runtime.version_info.every(Number.isInteger)
    || ![runtime.version, runtime.implementation, runtime.prefix, runtime.base_prefix, runtime.stdlib].every(value => typeof value === "string" && value.length > 0)
    || ![runtime.prefix, runtime.base_prefix, runtime.stdlib].every(isAbsolute)) {
    throw new Error(`Python runtime returned an invalid Python 3 identity: ${executable}`);
  }
  return runtime;
}

/** Resolve only an explicitly configured runtime; never manufacture an unavailable Python alias. */
export function resolveWorkspacePythonRuntime(options: WorkspaceHostOptions = {}): WorkspacePythonRuntime | undefined {
  const configured = options.pythonExecutable ?? process.env.TOOL_ROUTING_PYTHON_EXECUTABLE ?? options.expectedPythonRuntime?.executable;
  if (configured === undefined) {
    if (options.pythonVersion) throw new Error("pythonVersion requires an explicit Python executable");
    return undefined;
  }
  if (!isAbsolute(configured)) throw new Error("Python executable must be an absolute path");
  let executable: string;
  try { accessSync(configured, constants.X_OK); executable = realpathSync(configured); }
  catch { throw new Error(`Python executable is missing or not executable: ${configured}`); }
  const runtime: WorkspacePythonRuntime = { ...probePython(executable),
    executable_sha256: createHash("sha256").update(readFileSync(executable)).digest("hex") };
  if (options.pythonVersion && (!/^3\.\d+(?:\.\d+)?$/.test(options.pythonVersion)
    || runtime.version_info.slice(0, options.pythonVersion.split(".").length).join(".") !== options.pythonVersion)) {
    throw new Error(`Python version mismatch: required ${options.pythonVersion}, found ${runtime.version_info.join(".")}`);
  }
  if (options.expectedPythonRuntime && Object.keys(runtime).some(key =>
    JSON.stringify(runtime[key as keyof WorkspacePythonRuntime]) !== JSON.stringify(options.expectedPythonRuntime?.[key as keyof WorkspacePythonRuntime]))) {
    throw new Error("Python runtime differs from the frozen runtime identity");
  }
  return runtime;
}

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({
  type: "function" as const,
  function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
});
const string = { type: "string" };
export const WORKSPACE_TOOLS = [
  fn("Read", "Read a file in the current workspace.", { file_path: string }, ["file_path"]),
  fn("Grep", "Search workspace file contents with a regular expression.", { pattern: string }, ["pattern"]),
  fn("Write", "Create or replace a workspace file.", { file_path: string, content: string }, ["file_path", "content"]),
  fn("Edit", "Replace one unique exact occurrence in a workspace file.", {
    file_path: string, old_string: string, new_string: string,
  }, ["file_path", "old_string", "new_string"]),
  fn("Bash", "Run a shell command in the current workspace.", { command: string }, ["command"]),
];
export const WORKSPACE_SYSTEM = "You are a coding assistant working in a prepared workspace. Complete the user's request using the available tools. The workspace root is the current directory ('.'); workspace_repo is a repository identifier, not a filesystem path. Use the actual files and report what you did.";
export const WORKSPACE_LIMITATIONS = [
  "The workspace curl shim observes executed PATH-resolved curl calls, including calls inside scripts. Direct single-command absolute curl attempts are recorded as protocol-invalid; absolute curl in compound commands/scripts and arbitrary Python/Node HTTP attempts are not fully instrumented. External network remains sandbox-blocked.",
  "The minimum coding progress guard credits successful Read or executed PATH-resolved cat file operands, actual file-content changes, and successful Python -m unittest processes with a nonzero TestResult.testsRun. Equivalent unittest discovery/module commands are accepted; non-unittest configured commands retain exact-command process-success checking. This is not a code-correctness or task-completion metric.",
  "PATH shims observe cat and Python inside compound commands and scripts, including direct .py unittest entrypoints. With an explicit Python runtime, python/python3/python3.<minor> all invoke the same verified interpreter; otherwise only existing python/python3 executables are wrapped. Absolute-path executables, cat stdin redirection, custom Python file reads and custom test runners are not fully instrumented. The proxy production host is represented by workspace-cli-v1, not every IDE host.",
] as const;

/** Real files and shell processes, with cloud curl requests intercepted at execution time. */
export async function createWorkspaceHost(testCase: EvalCase, options: WorkspaceHostOptions = {}) {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) {
    throw new Error("workspace-cli-v1 requires macOS sandbox-exec; refusing an unsandboxed fallback");
  }
  const pythonRuntime = resolveWorkspacePythonRuntime(options);
  const pythonRuntimeSha256 = pythonRuntime ? createHash("sha256").update(JSON.stringify(pythonRuntime)).digest("hex") : undefined;
  const container = realpathSync(mkdtempSync(join(tmpdir(), "tool-routing-workspace-")));
  const root = join(container, "workspace"), bin = join(container, "bin");
  mkdirSync(root); mkdirSync(bin); mkdirSync(join(root, ".tmp"));
  const calls: ParsedCall[] = [], actions: NonNullable<RunRecord["local_actions"]> = [];
  type Execution = NonNullable<NonNullable<RunRecord["local_actions"]>[number]["execution"]>;
  const observedReads = new Set<string>();
  let observedTestRun = false;
  let expectedTestWords: string[] = [];
  try { expectedTestWords = shellWords(testCase.coding_expectation?.test_command ?? ""); } catch { /* Other configured harnesses retain their existing exact-command check. */ }
  const expectsUnittest = expectedTestWords.some((word, index) => word === "-m" && expectedTestWords[index + 1] === "unittest");
  const bridge = createMockBridge(testCase);
  let responseIndex = 0;
  const safePath = (relative: string): string => {
    const path = resolve(root, relative);
    if (path !== root && !path.startsWith(root + sep)) throw new Error("Path is outside the workspace");
    let ancestor = path;
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    const actual = realpathSync(ancestor);
    if (actual !== root && !actual.startsWith(root + sep)) throw new Error("Symlink escapes the workspace");
    return path;
  };
  for (const [name, text] of Object.entries(testCase.workspace_files ?? {})) {
    const path = safePath(name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text);
  }
  const progress = (): NonNullable<RunRecord["coding_progress"]> => {
    const expected = testCase.coding_expectation;
    const read = (expected?.read_paths ?? []).every(path => {
      try { return observedReads.has(safePath(path)); } catch { return false; }
    });
    const changed = (expected?.changed_paths ?? []).every(path => {
      try { return existsSync(safePath(path)) && readFileSync(safePath(path), "utf8") !== testCase.workspace_files?.[path]; }
      catch { return false; }
    });
    const tested = !expected?.test_command || observedTestRun;
    return { read, changed, tested, no_progress_or_early_abort: Boolean(expected) && !(read && changed && tested) };
  };
  const server = createServer(async (request, response) => {
    try {
      let text = "";
      for await (const part of request) {
        text += part;
        if (text.length > 1_000_000) throw new Error("Request too large");
      }
      const payload = JSON.parse(text);
      if (request.url === "/process") {
        const execution = payload as Execution;
        const success = execution.exit_code === 0 && execution.signal === null;
        actions.push({ tool: "Process", success, response_index: responseIndex, execution });
        if (success) {
          for (const path of execution.read_paths ?? []) {
            try { observedReads.add(safePath(resolve(execution.cwd, path))); } catch { /* Outside-workspace paths cannot satisfy progress. */ }
          }
          observedTestRun ||= expectsUnittest && execution.unittest?.successful === true
            && execution.unittest.tests_run > 0;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
        return;
      }
      const { argv } = payload as { argv: string[] };
      const parsed = parseCurlArgs(["curl", ...argv], `curl ${argv.map((arg) => JSON.stringify(arg)).join(" ")}`);
      parsed.response_index = responseIndex;
      parsed.action_index = calls.length;
      if (parsed.tool === "skill_extract") {
        const expected = testCase.coding_expectation;
        parsed.coding_validated_before_call = Boolean(expected?.read_paths?.length
          && expected.changed_paths?.length && expected.test_command && !progress().no_progress_or_early_abort);
      }
      calls.push(parsed);
      const result = parsed.protocol_valid ? bridge.handle(parsed)
        : { code: 40001, message: parsed.error ?? "Invalid request" };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch { response.writeHead(400); response.end('{"code":40001,"message":"Invalid request"}'); }
  });
  await new Promise<void>((ready, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", ready); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Bridge did not bind");
  const endpoint = `http://127.0.0.1:${address.port}`;
  // This executable is reached by an actual shell invocation, including scripts.
  // It has no provider credential and cannot contact production cloud services.
  writeFileSync(join(bin, "curl"), `#!/usr/bin/env node
const fs = require('node:fs');
(async () => {
  const argv = process.argv.slice(2);
  for (let i=0;i<argv.length;i++) {
    if (['-d','--data','--data-binary'].includes(argv[i]) && argv[i+1]?.startsWith('@')) argv[i+1]=fs.readFileSync(argv[i+1].slice(1),'utf8');
  }
  const response = await fetch(${JSON.stringify(endpoint)}, {method:'POST',body:JSON.stringify({argv})});
  const text = await response.text();
  const outIndex = argv.findIndex(x => x === '-o' || x === '--output');
  if (outIndex >= 0) fs.writeFileSync(argv[outIndex+1], text); else process.stdout.write(text);
})().catch(error => { process.stderr.write(error.message); process.exitCode=1; });
`, { mode: 0o700 });
  // Read the real unittest TestResult on a separate pipe. Shell output (including
  // an echoed "Ran 5 tests / OK") is never evidence that tests actually ran.
  const unittestBootstrap = join(bin, "observe-unittest.py");
  writeFileSync(unittestBootstrap, `import json, os, runpy, sys, unittest
original_run = unittest.TextTestRunner.run
def observed_run(self, test):
    result = original_run(self, test)
    os.write(3, (json.dumps({"tests_run": result.testsRun, "successful": result.wasSuccessful()}) + "\\n").encode())
    return result
unittest.TextTestRunner.run = observed_run
mode, *arguments = sys.argv[1:]
if mode == "--module":
    sys.path.insert(0, os.getcwd())
    unittest.main(module=None, argv=["python -m unittest", *arguments])
else:
    script, *tail = arguments
    sys.argv = [script, *tail]
    if not getattr(sys.flags, "safe_path", False):
        sys.path[0] = os.path.dirname(os.path.abspath(script))
    runpy.run_path(script, run_name="__main__")
`);
  const pythonAliases = pythonRuntime ? ["python", "python3", `python3.${pythonRuntime.version_info[1]}`] : ["python3", "python"];
  for (const name of ["cat", ...pythonAliases]) {
    const executable = name !== "cat" && pythonRuntime ? pythonRuntime.executable : systemPath.split(":").map((directory) => join(directory, name)).find((path) => {
      try { accessSync(path, constants.X_OK); return true; } catch { return false; }
    });
    if (!executable) continue;
    writeFileSync(join(bin, name), `#!/usr/bin/env node
const {spawn} = require('node:child_process');
const argv = process.argv.slice(2), cwd = process.cwd();
const executable = ${JSON.stringify(executable)}, name = ${JSON.stringify(name)};
let moduleIndex = -1, scriptIndex = -1;
if (name !== 'cat') {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-m') { if (argv[i + 1] === 'unittest') moduleIndex = i; break; }
    if (['-W', '-X', '--check-hash-based-pycs'].includes(argv[i])) { i++; continue; }
    if (!/^-(?:[bBOquvEsSI]+|W.+|X.+)$/.test(argv[i])) {
      if (!argv[i].startsWith('-') && argv[i].endsWith('.py')) scriptIndex = i;
      break;
    }
  }
}
const childArgs = moduleIndex >= 0 ? [...argv.slice(0, moduleIndex), ${JSON.stringify(unittestBootstrap)}, '--module', ...argv.slice(moduleIndex + 2)]
  : scriptIndex >= 0 ? [...argv.slice(0, scriptIndex), ${JSON.stringify(unittestBootstrap)}, '--script', ...argv.slice(scriptIndex)] : argv;
const child = spawn(executable, childArgs, {stdio: ['inherit', 'inherit', 'inherit', 'pipe']});
let measurement = '', spawnError;
child.stdio[3].on('data', data => { if (measurement.length < 65536) measurement += data.toString(); });
child.on('error', error => { spawnError = error; process.stderr.write(error.message); });
child.on('close', async (exit_code, signal) => {
  const execution = {executable, invoked_as: name, argv, cwd, exit_code, signal};
  if (name !== 'cat' && ${Boolean(pythonRuntime)}) execution.python_runtime_sha256 = ${JSON.stringify(pythonRuntimeSha256 ?? null)};
  if (name === 'cat') {
    let operands = false;
    execution.read_paths = argv.filter(arg => {
      if (arg === '--' && !operands) { operands = true; return false; }
      return arg !== '-' && (operands || !arg.startsWith('-'));
    });
  }
  if (moduleIndex >= 0 || scriptIndex >= 0) {
    const results = measurement.trim().split('\\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } });
    if (results.length === 1 && Number.isInteger(results[0]?.tests_run) && typeof results[0]?.successful === 'boolean') execution.unittest = results[0];
  }
  try { await fetch(${JSON.stringify(endpoint + "/process")}, {method: 'POST', body: JSON.stringify(execution)}); }
  catch (error) { process.stderr.write('Observation failed: ' + error.message); }
  process.exitCode = spawnError ? 127 : (exit_code ?? 1);
});
`, { mode: 0o700 });
  }
  const profile = [
    "(version 1)", "(allow default)", "(deny file-read*)", "(deny file-write*)", "(deny network*)",
    "(allow sysctl-read)", "(allow mach-lookup)", "(allow file-read-metadata)",
    '(allow file-read* (literal "/"))',
    ...["/System", "/usr", "/bin", "/sbin", "/Library/Apple", "/private/preboot", "/private/var/db/dyld", "/opt/homebrew", dirname(process.execPath), container,
      ...(pythonRuntime ? [dirname(pythonRuntime.executable), pythonRuntime.prefix, pythonRuntime.base_prefix, pythonRuntime.stdlib] : [])]
      .map((path) => `(allow file-read* (subpath ${JSON.stringify(path)}))`),
    `(allow file-write* (subpath ${JSON.stringify(root)}))`,
    '(allow file-read* file-write* (subpath "/dev"))',
    `(allow network-outbound (remote ip "localhost:${address.port}"))`,
  ].join("\n");
  if (pythonRuntime) {
    try {
      const { executable_sha256: _, ...identity } = pythonRuntime;
      if (JSON.stringify(probePython(pythonRuntime.executable, profile)) !== JSON.stringify(identity)) {
        throw new Error("Python runtime identity changed inside workspace sandbox");
      }
    } catch (error) {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
      rmSync(container, { recursive: true, force: true });
      throw error;
    }
  }
  const shell = async (command: string): Promise<{ output: string; success: boolean }> => {
    return new Promise((done) => {
      const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", command], {
        cwd: root, detached: true,
        env: { PATH: `${bin}:${systemPath}`, LANG: "en_US.UTF-8", TMPDIR: join(root, ".tmp") },
      });
      let output = "", timedOut = false;
      const stop = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } };
      const timer = setTimeout(() => { timedOut = true; stop(); }, 15_000);
      const collect = (data: Buffer) => { output += data.toString(); if (output.length > 65_536) stop(); };
      child.stdout.on("data", collect); child.stderr.on("data", collect);
      child.on("error", (error) => { clearTimeout(timer); done({ output: error.message, success: false }); });
      child.on("close", (code, signal) => { clearTimeout(timer); done({
        output: output.slice(0, 65_536) + (timedOut ? "\nCommand timed out" : "")
          + (code === 0 ? "" : `\n[exit=${code}; signal=${signal}]`), success: code === 0 && !timedOut,
      }); });
    });
  };
  return {
    root, calls, actions, pythonRuntime, pythonRuntimeSha256,
    async execute(name: string, args: Record<string, string>, currentResponseIndex: number): Promise<string> {
      responseIndex = currentResponseIndex;
      const action = { tool: name, path: args.file_path, command: args.command, success: false, response_index: responseIndex };
      actions.push(action);
      // Injected names are curl endpoints, not registered native functions.
      // A model that invents such a native call has still attempted cloud use.
      const nativeFamily = name.startsWith("tdai_") ? "memory"
        : name.startsWith("skill_") ? "skill"
          : name.startsWith("knowledge_") || name.startsWith("tools/") || Object.hasOwn(args, "knowledge_id") ? "knowledge" : undefined;
      if (nativeFamily) {
        calls.push({ command: `native:${name}`, family: nativeFamily, tool: name, body: args,
          protocol_valid: false, error: "Cloud tool was requested as an unregistered native function",
          response_index: responseIndex, action_index: calls.length });
      }
      try {
        let output: string;
        if (name === "Read") {
          const path = safePath(args.file_path);
          output = readFileSync(path, "utf8").slice(0, 32_768);
          observedReads.add(path);
        }
        else if (name === "Write") {
          const path = safePath(args.file_path); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, args.content); output = "File written";
        } else if (name === "Edit") {
          const path = safePath(args.file_path), content = readFileSync(path, "utf8");
          if (!args.old_string || content.split(args.old_string).length !== 2) throw new Error("old_string must match exactly once");
          writeFileSync(path, content.replace(args.old_string, () => args.new_string)); output = "File edited";
        } else if (name === "Bash" || name === "Grep") {
          const command = name === "Bash" ? args.command : `rg --line-number -- ${"'" + args.pattern.replaceAll("'", "'\\''") + "'"} .`;
          let words: string[] = [];
          try { words = shellWords(command); } catch { /* Executed PATH shims observe compound commands; only direct absolute curl is checked here. */ }
          if (words[0]?.startsWith("/") && words[0].split("/").at(-1) === "curl") {
            const attempt = parseCurlArgs(words, command);
            if (attempt.family) calls.push({ ...attempt, protocol_valid: false,
              error: "Absolute-path curl bypasses the local mock; network access is blocked by the workspace sandbox",
              response_index: responseIndex, action_index: calls.length });
          }
          const result = await shell(command);
          action.success = result.success;
          if (!expectsUnittest && name === "Bash" && result.success && command.trim() === testCase.coding_expectation?.test_command) {
            observedTestRun = true;
          }
          return result.output;
        } else throw new Error(`Unknown workspace tool: ${name}`);
        action.success = true;
        return output;
      } catch (error) { return `Tool error: ${(error as Error).message}`; }
    },
    progress,
    completedStepIds: bridge.completedStepIds,
    async close() {
      server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
      rmSync(container, { recursive: true, force: true });
    },
  };
}
