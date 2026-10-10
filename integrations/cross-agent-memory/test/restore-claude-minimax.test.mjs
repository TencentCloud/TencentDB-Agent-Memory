import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cliRestoreOptions, restoreClaudeMiniMax } from "../src/restore-claude-minimax.mjs";

const execFileAsync = promisify(execFile);
const CLI_PATH = fileURLToPath(new URL("../src/restore-claude-minimax.mjs", import.meta.url));

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function withSandbox(run) {
  const root = await mkdtemp(join(tmpdir(), "cross-agent-minimax-restore-"));
  const userProfile = join(root, "home");
  const runtimeDir = join(root, "runtime");
  await mkdir(userProfile, { recursive: true });
  const priorHome = process.env.HOME;
  const priorUserProfile = process.env.USERPROFILE;
  process.env.HOME = userProfile;
  process.env.USERPROFILE = userProfile;
  try {
    await run({ root, userProfile, runtimeDir });
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = priorUserProfile;
    await rm(root, { recursive: true, force: true });
  }
}

function sourceConfig(overrides = {}) {
  return {
    env: {
      ANTHROPIC_BASE_URL: "https://api.minimaxi.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "source-secret-token",
      SOURCE_ONLY: "preserved-at-source-only"
    },
    ...overrides
  };
}

function targetConfig(overrides = {}) {
  return {
    model: "MiniMax-M2.1",
    plugins: { "existing-plugin": true },
    permissions: { allow: ["Read"] },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "notify.exe" }] }] },
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8096/anthropic",
      ANTHROPIC_AUTH_TOKEN: "old-secret-token",
      ANTHROPIC_CUSTOM_HEADERS: "x-memory: true",
      KEEP: "yes"
    },
    ...overrides
  };
}

test("restore merges only official MiniMax fields and preserves all other target semantics", async () => {
  await withSandbox(async ({ root, userProfile, runtimeDir }) => {
    const sourcePath = join(root, "trusted-backup.json");
    const targetPath = join(userProfile, ".claude", "settings.json");
    const original = targetConfig();
    await writeJson(sourcePath, sourceConfig());
    await writeJson(targetPath, original);

    const result = await restoreClaudeMiniMax({ sourcePath, userProfile, runtimeDir });
    const restored = await readJson(targetPath);

    assert.equal(result.status, "RESTORED");
    assert.equal(result.sourcePath, resolve(sourcePath));
    assert.equal(result.targetPath, resolve(targetPath));
    assert.deepEqual(restored, {
      ...original,
      env: {
        ANTHROPIC_BASE_URL: "https://api.minimaxi.com/anthropic",
        ANTHROPIC_AUTH_TOKEN: "source-secret-token",
        KEEP: "yes"
      }
    });
    assert.equal(restored.env.SOURCE_ONLY, undefined);
    assert.equal(restored.env.ANTHROPIC_CUSTOM_HEADERS, undefined);
  });
});

test("restore rejects non-UTF-8 or invalid JSON source and target files without replacement", async () => {
  await withSandbox(async ({ root, userProfile, runtimeDir }) => {
    const sourcePath = join(root, "trusted-backup.json");
    const targetPath = join(userProfile, ".claude", "settings.json");
    const original = Buffer.from('{\r\n  "model": "keep"\r\n}\r\n', "utf8");
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, original);

    await writeFile(sourcePath, Buffer.from([0x7b, 0xff, 0x7d]));
    await assert.rejects(restoreClaudeMiniMax({ sourcePath, userProfile, runtimeDir }), /source.*JSON/i);
    assert.deepEqual(await readFile(targetPath), original);

    await writeFile(sourcePath, "{ not json", "utf8");
    await assert.rejects(restoreClaudeMiniMax({ sourcePath, userProfile, runtimeDir }), /source.*JSON/i);
    assert.deepEqual(await readFile(targetPath), original);

    await writeJson(sourcePath, sourceConfig());
    const malformedTarget = Buffer.from("{ target is broken", "utf8");
    await writeFile(targetPath, malformedTarget);
    await assert.rejects(restoreClaudeMiniMax({ sourcePath, userProfile, runtimeDir }), /target.*JSON/i);
    assert.deepEqual(await readFile(targetPath), malformedTarget);

    const nonUtf8Target = Buffer.from([0x7b, 0xff, 0x7d]);
    await writeFile(targetPath, nonUtf8Target);
    await assert.rejects(restoreClaudeMiniMax({ sourcePath, userProfile, runtimeDir }), /target.*JSON/i);
    assert.deepEqual(await readFile(targetPath), nonUtf8Target);
    await assert.rejects(readdir(join(runtimeDir, "backups")), { code: "ENOENT" });
  });
});

test("restore refuses a non-MiniMax source, missing token, missing target, or non-object target", async () => {
  await withSandbox(async ({ root, userProfile, runtimeDir }) => {
    const sourcePath = join(root, "trusted-backup.json");
    const targetPath = join(userProfile, ".claude", "settings.json");
    await writeJson(targetPath, targetConfig());

    await writeJson(sourcePath, sourceConfig({ env: { ANTHROPIC_BASE_URL: "https://wrong.example/anthropic", ANTHROPIC_AUTH_TOKEN: "source-secret-token" } }));
    await assert.rejects(restoreClaudeMiniMax({ sourcePath, userProfile, runtimeDir }), /official MiniMax/i);

    await writeJson(sourcePath, sourceConfig({ env: { ANTHROPIC_BASE_URL: "https://api.minimaxi.com/anthropic", ANTHROPIC_AUTH_TOKEN: "  " } }));
    await assert.rejects(restoreClaudeMiniMax({ sourcePath, userProfile, runtimeDir }), /token/i);

    await rm(targetPath);
    await writeJson(sourcePath, sourceConfig());
    await assert.rejects(restoreClaudeMiniMax({ sourcePath, userProfile, runtimeDir }), /target.*exist/i);

    await writeFile(targetPath, "[]\n", "utf8");
    await assert.rejects(restoreClaudeMiniMax({ sourcePath, userProfile, runtimeDir }), /target.*JSON object/i);
    await assert.rejects(readdir(join(runtimeDir, "backups")), { code: "ENOENT" });
  });
});

test("restore backs up the exact original bytes and a failed rename keeps the target unchanged", async () => {
  await withSandbox(async ({ root, userProfile, runtimeDir }) => {
    const sourcePath = join(root, "trusted-backup.json");
    const targetPath = join(userProfile, ".claude", "settings.json");
    const original = Buffer.from('{\r\n  "model": "keep",\r\n  "env": { "KEEP": "yes" }\r\n}\r\n', "utf8");
    await writeJson(sourcePath, sourceConfig());
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, original);

    await assert.rejects(
      restoreClaudeMiniMax({
        sourcePath,
        userProfile,
        runtimeDir,
        now: () => new Date("2026-08-10T00:00:00.000Z"),
        renameFile: async () => { throw new Error("simulated sharing violation"); }
      }),
      /replace/i
    );

    assert.deepEqual(await readFile(targetPath), original);
    const backupRuns = await readdir(join(runtimeDir, "backups"));
    assert.equal(backupRuns.length, 1);
    assert.deepEqual(
      await readFile(join(runtimeDir, "backups", backupRuns[0], "settings.json")),
      original
    );
    assert.deepEqual(await readdir(dirname(targetPath)), ["settings.json"]);
  });
});

test("restore is idempotent and creates no extra backup after its first successful run", async () => {
  await withSandbox(async ({ root, userProfile, runtimeDir }) => {
    const sourcePath = join(root, "trusted-backup.json");
    const targetPath = join(userProfile, ".claude", "settings.json");
    await writeJson(sourcePath, sourceConfig());
    await writeJson(targetPath, targetConfig());

    await restoreClaudeMiniMax({ sourcePath, userProfile, runtimeDir });
    const afterFirstRun = await readFile(targetPath, "utf8");
    const backups = await readdir(join(runtimeDir, "backups"));
    const result = await restoreClaudeMiniMax({ sourcePath, userProfile, runtimeDir });

    assert.deepEqual(result, { status: "UNCHANGED", sourcePath: resolve(sourcePath), targetPath: resolve(targetPath), backupPath: null });
    assert.equal(await readFile(targetPath, "utf8"), afterFirstRun);
    assert.deepEqual(await readdir(join(runtimeDir, "backups")), backups);
  });
});

test("CLI uses an explicit source path, honors the guarded test profile, returns status, and never exposes the token", async () => {
  await withSandbox(async ({ root, userProfile, runtimeDir }) => {
    const sourcePath = join(root, "trusted-backup.json");
    const targetPath = join(userProfile, ".claude", "settings.json");
    const productionProfile = join(root, "not-the-test-target");
    const secret = "cli-secret-token";
    await writeJson(sourcePath, sourceConfig({ env: { ANTHROPIC_BASE_URL: "https://api.minimaxi.com/anthropic", ANTHROPIC_AUTH_TOKEN: secret } }));
    await writeJson(targetPath, targetConfig());

    const environment = {
      ...process.env,
      HOME: productionProfile,
      USERPROFILE: productionProfile,
      CROSS_AGENT_MEMORY_TEST_MODE: "1",
      CROSS_AGENT_MEMORY_TEST_USERPROFILE: userProfile,
      CROSS_AGENT_MEMORY_TEST_RUNTIME_DIR: runtimeDir
    };
    const result = await execFileAsync(process.execPath, [CLI_PATH, sourcePath], { env: environment });
    assert.match(result.stdout, /\[RESTORED\]/);
    assert.match(result.stdout, new RegExp(resolve(sourcePath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(result.stdout, new RegExp(resolve(targetPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);

    await assert.rejects(
      execFileAsync(process.execPath, [CLI_PATH, "--not-a-path"], { env: environment }),
      (error) => error.code === 1 && `${error.stdout}${error.stderr}`.includes(secret) === false
    );
    await assert.rejects(
      execFileAsync(process.execPath, [CLI_PATH, sourcePath, "unexpected-argument"], { env: environment }),
      (error) => error.code === 1 && `${error.stdout}${error.stderr}`.includes(secret) === false
    );
  });
});

test("CLI failure after reading a secret never exposes it and leaves the test target unchanged", async () => {
  await withSandbox(async ({ root, userProfile, runtimeDir }) => {
    const sourcePath = join(root, "bad-trusted-backup.json");
    const targetPath = join(userProfile, ".claude", "settings.json");
    const secret = "wrong-domain-child-process-secret";
    const original = Buffer.from(`${JSON.stringify(targetConfig(), null, 2)}\r\n`, "utf8");
    await writeJson(sourcePath, sourceConfig({ env: {
      ANTHROPIC_BASE_URL: "https://wrong.example/anthropic",
      ANTHROPIC_AUTH_TOKEN: secret
    } }));
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, original);

    const environment = {
      ...process.env,
      HOME: join(root, "not-the-test-target"),
      USERPROFILE: join(root, "not-the-test-target"),
      CROSS_AGENT_MEMORY_TEST_MODE: "1",
      CROSS_AGENT_MEMORY_TEST_USERPROFILE: userProfile,
      CROSS_AGENT_MEMORY_TEST_RUNTIME_DIR: runtimeDir
    };
    let failure;
    try {
      await execFileAsync(process.execPath, [CLI_PATH, sourcePath], { env: environment });
    } catch (error) {
      failure = error;
    }

    assert.equal(failure?.code, 1);
    assert.equal(`${failure.stdout}${failure.stderr}`.includes(secret), false);
    assert.deepEqual(await readFile(targetPath), original);
  });
});

test("test-only CLI path overrides require the explicit test-mode guard", async () => {
  const sourcePath = resolve("trusted-backup.json");
  const injectedProfile = resolve("test-only-profile");
  const injectedRuntime = resolve("test-only-runtime");

  assert.deepEqual(
    cliRestoreOptions(sourcePath, {
      CROSS_AGENT_MEMORY_TEST_USERPROFILE: injectedProfile,
      CROSS_AGENT_MEMORY_TEST_RUNTIME_DIR: injectedRuntime
    }),
    { sourcePath }
  );
  assert.deepEqual(
    cliRestoreOptions(sourcePath, {
      CROSS_AGENT_MEMORY_TEST_MODE: "1",
      CROSS_AGENT_MEMORY_TEST_USERPROFILE: injectedProfile,
      CROSS_AGENT_MEMORY_TEST_RUNTIME_DIR: injectedRuntime
    }),
    { sourcePath, userProfile: injectedProfile, runtimeDir: injectedRuntime }
  );

  await withSandbox(async ({ root }) => {
    const sourcePath = join(root, "trusted-backup.json");
    const productionProfile = join(root, "production-profile");
    const injectedProfile = join(root, "ignored-test-profile");
    const targetPath = join(productionProfile, ".claude", "settings.json");
    const secret = "guarded-profile-secret";
    await writeJson(sourcePath, sourceConfig({ env: {
      ANTHROPIC_BASE_URL: "https://api.minimaxi.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: secret
    } }));
    await writeJson(targetPath, targetConfig({ env: {
      ANTHROPIC_BASE_URL: "https://api.minimaxi.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: secret,
      KEEP: "yes"
    } }));
    const environment = {
      ...process.env,
      HOME: productionProfile,
      USERPROFILE: productionProfile,
      CROSS_AGENT_MEMORY_TEST_USERPROFILE: injectedProfile,
      CROSS_AGENT_MEMORY_TEST_RUNTIME_DIR: join(root, "ignored-test-runtime")
    };
    delete environment.CROSS_AGENT_MEMORY_TEST_MODE;

    const result = await execFileAsync(process.execPath, [CLI_PATH, sourcePath], { env: environment });
    assert.match(result.stdout, /\[UNCHANGED\]/);
    assert.match(result.stdout, new RegExp(resolve(targetPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(result.stdout.includes(resolve(injectedProfile)), false);
    assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
  });
});
