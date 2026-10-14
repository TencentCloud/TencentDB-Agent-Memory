import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { installHooks, uninstallHooks } from "../src/install-hooks.mjs";

const ADAPTER_PATH = resolve("integrations/cross-agent-memory/src/hook-cli.mjs");

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function listOrEmpty(path) {
  try {
    return await readdir(path);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function withSandbox(run, { remove = rm } = {}) {
  const root = await mkdtemp(join(tmpdir(), "cross-agent-hooks-"));
  const userProfile = join(root, "home");
  const runtimeDir = join(root, "runtime");
  await mkdir(userProfile, { recursive: true });

  const oldHome = process.env.HOME;
  const oldUserProfile = process.env.USERPROFILE;
  process.env.HOME = userProfile;
  process.env.USERPROFILE = userProfile;
  let primaryError;
  try {
    await run({ root, userProfile, runtimeDir });
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors = [];
  try {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    if (oldUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldUserProfile;
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await remove(root, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError([primaryError, ...cleanupErrors], "sandbox body and cleanup both failed");
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "sandbox cleanup failed");
}

function managedCount(config, event, client) {
  if (client === "zcode") {
    return config.hooks.events[event].reduce((count, group) => count +
      (group.hooks ?? []).filter((entry) =>
        entry.type === "process" && entry.command === "node" &&
        entry.args?.[0] === ADAPTER_PATH && entry.args?.[1] === "zcode"
      ).length, 0);
  }
  return config.hooks[event].filter((block) =>
    block.hooks?.some((entry) =>
      client === "codex"
        ? entry.commandWindows === `node "${ADAPTER_PATH}" codex`
        : entry.command === `node "${ADAPTER_PATH}" claude`
    )
  ).length;
}

test("install uses current Codex hooks format and preserves all three rich configs", async () => {
  await withSandbox(async ({ userProfile, runtimeDir }) => {
    const codexPath = join(userProfile, ".codex", "hooks.json");
    const claudePath = join(userProfile, ".claude", "settings.json");
    const zcodePath = join(userProfile, ".zcode", "cli", "config.json");
    const codexOriginal = {
      description: "existing Codex hooks",
      customTopLevel: { keep: true },
      hooks: {
        UserPromptSubmit: [{ hooks: [{
          type: "command",
          command: `node ${ADAPTER_PATH.replaceAll("\\", "/")}.old codex`,
          commandWindows: `node "${ADAPTER_PATH}.old" codex`
        }] }],
        Notification: [{ hooks: [{ type: "command", command: "notify-codex.exe" }] }]
      }
    };
    const claudeOriginal = {
      model: "MiniMax-M2.1",
      env: {
        ANTHROPIC_BASE_URL: "https://api.minimax.example/v1",
        ANTHROPIC_AUTH_TOKEN: "keep-secret-reference"
      },
      plugins: { "existing-plugin": true },
      permissions: { allow: ["Read"] },
      hooks: {
        UserPromptSubmit: [{ hooks: [{
          type: "command",
          command: `node "${ADAPTER_PATH}-backup" claude`,
          timeout: 9
        }] }],
        Notification: [{ hooks: [{ type: "command", command: "notify.exe" }] }]
      }
    };
    const zcodeOriginal = {
      model: { provider: "unchanged-provider", name: "unchanged-model" },
      mcp: { filesystem: { command: "server.exe", args: ["D:\\data"] } },
      plugins: ["existing-zcode-plugin"],
      custom: { nested: [1, { keep: true }] },
      hooks: {
        enabled: false,
        events: {
          UserPromptSubmit: [{ hooks: [{
            type: "process",
            command: "node",
            args: [`${ADAPTER_PATH}.old`, "zcode"]
          }] }],
          AfterTool: [{ hooks: [{ type: "process", command: "audit.exe", args: [] }] }]
        }
      }
    };
    const codexBytes = `${JSON.stringify(codexOriginal, null, 2)}\n`;
    const claudeBytes = `${JSON.stringify(claudeOriginal, null, 2)}\n`;
    const zcodeBytes = `${JSON.stringify(zcodeOriginal, null, 2)}\n`;
    await writeJson(codexPath, codexOriginal);
    await writeJson(claudePath, claudeOriginal);
    await writeJson(zcodePath, zcodeOriginal);

    const result = await installHooks({ userProfile, runtimeDir, adapterPath: ADAPTER_PATH });

    const codex = await readJson(codexPath);
    assert.equal(codex.description, codexOriginal.description);
    assert.deepEqual(codex.customTopLevel, codexOriginal.customTopLevel);
    assert.deepEqual(codex.hooks.Notification, codexOriginal.hooks.Notification);
    assert.deepEqual(codex.hooks.UserPromptSubmit[0], codexOriginal.hooks.UserPromptSubmit[0]);
    for (const event of ["UserPromptSubmit", "Stop"]) {
      assert.equal(managedCount(codex, event, "codex"), 1);
      const managed = codex.hooks[event].at(-1);
      assert.equal("matcher" in managed, false);
      assert.deepEqual(managed.hooks, [{
        type: "command",
        command: `node ${ADAPTER_PATH.replaceAll("\\", "/")} codex`,
        commandWindows: `node "${ADAPTER_PATH}" codex`,
        timeout: 5
      }]);
    }

    const claude = await readJson(claudePath);
    assert.equal(claude.model, claudeOriginal.model);
    assert.deepEqual(claude.env, claudeOriginal.env);
    assert.deepEqual(claude.plugins, claudeOriginal.plugins);
    assert.deepEqual(claude.permissions, claudeOriginal.permissions);
    assert.deepEqual(claude.hooks.Notification, claudeOriginal.hooks.Notification);
    assert.deepEqual(claude.hooks.UserPromptSubmit[0], claudeOriginal.hooks.UserPromptSubmit[0]);
    for (const event of ["UserPromptSubmit", "Stop"]) {
      assert.equal(managedCount(claude, event, "claude"), 1);
      const managed = claude.hooks[event].at(-1);
      assert.equal("matcher" in managed, false);
      assert.deepEqual(managed.hooks, [{
        type: "command",
        command: `node "${ADAPTER_PATH}" claude`,
        timeout: 5
      }]);
    }

    const zcode = await readJson(zcodePath);
    assert.deepEqual(zcode.model, zcodeOriginal.model);
    assert.deepEqual(zcode.mcp, zcodeOriginal.mcp);
    assert.deepEqual(zcode.plugins, zcodeOriginal.plugins);
    assert.deepEqual(zcode.custom, zcodeOriginal.custom);
    assert.deepEqual(zcode.hooks.events.AfterTool, zcodeOriginal.hooks.events.AfterTool);
    assert.deepEqual(zcode.hooks.events.UserPromptSubmit[0], zcodeOriginal.hooks.events.UserPromptSubmit[0]);
    assert.equal(zcode.hooks.enabled, true);
    for (const event of ["UserPromptSubmit", "Stop"]) {
      assert.equal(managedCount(zcode, event, "zcode"), 1);
      const managed = zcode.hooks.events[event].at(-1);
      assert.equal("matcher" in managed, false);
      assert.deepEqual(managed.hooks, [{
          type: "process",
          command: "node",
          args: [ADAPTER_PATH, "zcode"],
          enabled: true,
          timeoutMs: 5000
        }]);
    }

    assert.deepEqual(result.changed.sort(), ["claude", "codex", "zcode"]);
    assert.equal(await readFile(join(result.backupDir, ".codex", "hooks.json"), "utf8"), codexBytes);
    assert.equal(await readFile(join(result.backupDir, ".claude", "settings.json"), "utf8"), claudeBytes);
    assert.equal(await readFile(join(result.backupDir, ".zcode", "cli", "config.json"), "utf8"), zcodeBytes);
  });
});

test("install creates missing configs, is idempotent, and does not add backups when nothing changes", async () => {
  await withSandbox(async ({ userProfile, runtimeDir }) => {
    await installHooks({ userProfile, runtimeDir, adapterPath: ADAPTER_PATH });
    const first = {
      codex: await readFile(join(userProfile, ".codex", "hooks.json"), "utf8"),
      claude: await readFile(join(userProfile, ".claude", "settings.json"), "utf8"),
      zcode: await readFile(join(userProfile, ".zcode", "cli", "config.json"), "utf8")
    };
    const backupRunsBefore = await listOrEmpty(join(runtimeDir, "backups"));

    const result = await installHooks({ userProfile, runtimeDir, adapterPath: ADAPTER_PATH });

    assert.deepEqual(result.changed, []);
    assert.equal(result.backupDir, null);
    assert.deepEqual(await listOrEmpty(join(runtimeDir, "backups")), backupRunsBefore);
    assert.equal(await readFile(join(userProfile, ".codex", "hooks.json"), "utf8"), first.codex);
    assert.equal(await readFile(join(userProfile, ".claude", "settings.json"), "utf8"), first.claude);
    assert.equal(await readFile(join(userProfile, ".zcode", "cli", "config.json"), "utf8"), first.zcode);
    for (const [client, path] of [
      ["codex", join(userProfile, ".codex", "hooks.json")],
      ["claude", join(userProfile, ".claude", "settings.json")],
      ["zcode", join(userProfile, ".zcode", "cli", "config.json")]
    ]) {
      const config = await readJson(path);
      for (const event of ["UserPromptSubmit", "Stop"]) {
        assert.equal(managedCount(config, event, client), 1);
      }
    }
  });
});

test("reinstall preserves Claude direct provider fields and the established official adapter identity", async () => {
  await withSandbox(async ({ root, userProfile, runtimeDir }) => {
    const claudePath = join(userProfile, ".claude", "settings.json");
    const adapterRoot = join(root, "adapter");
    const adapterPath = join(adapterRoot, "src", "hook-cli.mjs");
    const adapterConfigPath = join(adapterRoot, "config.local.json");
    const claudeOriginal = {
      model: "MiniMax-M2.1",
      provider: "minimax",
      env: {
        ANTHROPIC_BASE_URL: "https://api.minimaxi.com/anthropic",
        ANTHROPIC_AUTH_TOKEN: "direct-minimax-token",
        ANTHROPIC_CUSTOM_HEADERS: "x-client: claude-code"
      }
    };
    const officialAdapterConfig = {
      endpoint: "http://127.0.0.1:8420",
      apiKey: "local-bearer-disabled-compatibility",
      serviceId: "default",
      identity: {
        userId: "usr-official",
        teamId: "team-official",
        agentId: "agt-official",
        taskId: "task-official"
      }
    };
    await writeJson(claudePath, claudeOriginal);
    await writeJson(adapterConfigPath, officialAdapterConfig);
    const adapterConfigBytes = await readFile(adapterConfigPath, "utf8");

    await installHooks({ client: "claude", userProfile, runtimeDir, adapterPath });
    const result = await installHooks({ client: "claude", userProfile, runtimeDir, adapterPath });

    const claude = await readJson(claudePath);
    assert.equal(claude.model, claudeOriginal.model);
    assert.equal(claude.provider, claudeOriginal.provider);
    assert.deepEqual(claude.env, claudeOriginal.env);
    for (const event of ["UserPromptSubmit", "Stop"]) {
      assert.equal(claude.hooks[event].filter((block) =>
        block.hooks?.some((entry) => entry.command === `node "${adapterPath}" claude`)
      ).length, 1);
    }
    assert.deepEqual(result, { changed: [], backupDir: null });
    assert.equal(await readFile(adapterConfigPath, "utf8"), adapterConfigBytes);
  });
});

test("uninstall removes only this exact adapter path and preserves later user changes", async () => {
  await withSandbox(async ({ userProfile, runtimeDir }) => {
    await installHooks({ userProfile, runtimeDir, adapterPath: ADAPTER_PATH });
    const codexPath = join(userProfile, ".codex", "hooks.json");
    const claudePath = join(userProfile, ".claude", "settings.json");
    const zcodePath = join(userProfile, ".zcode", "cli", "config.json");
    const codex = await readJson(codexPath);
    const claude = await readJson(claudePath);
    const zcode = await readJson(zcodePath);
    codex.hooks.Stop[0].hooks.push({ type: "command", command: "node retained-same-block.mjs" });
    zcode.hooks.events.Stop[0].hooks.push({
      type: "process",
      command: "node",
      args: ["retained-same-group.mjs"]
    });
    codex.description = "added after install";
    codex.hooks.Stop.push({ hooks: [{
      type: "command",
      command: `node ${ADAPTER_PATH.replaceAll("\\", "/")}.old codex`,
      commandWindows: `node "${ADAPTER_PATH}.old" codex`
    }] });
    claude.env = { MINIMAX_API_KEY: "still-present" };
    claude.hooks.Stop.push({ hooks: [{
      type: "command",
      command: `node "${ADAPTER_PATH}-backup" claude`
    }] });
    zcode.plugins = ["added-after-install"];
    zcode.hooks.events.Stop.push({ hooks: [{
      type: "process",
      command: "node",
      args: [`${ADAPTER_PATH}.old`, "zcode"]
    }] });
    await writeJson(codexPath, codex);
    await writeJson(claudePath, claude);
    await writeJson(zcodePath, zcode);
    const beforeUninstall = {
      codex: await readFile(codexPath, "utf8"),
      claude: await readFile(claudePath, "utf8"),
      zcode: await readFile(zcodePath, "utf8")
    };

    const result = await uninstallHooks({ userProfile, runtimeDir, adapterPath: ADAPTER_PATH });

    const after = {
      codex: await readJson(codexPath),
      claude: await readJson(claudePath),
      zcode: await readJson(zcodePath)
    };
    assert.equal(after.codex.description, "added after install");
    assert.equal(after.claude.env.MINIMAX_API_KEY, "still-present");
    assert.deepEqual(after.zcode.plugins, ["added-after-install"]);
    for (const event of ["UserPromptSubmit", "Stop"]) {
      assert.equal(managedCount(after.codex, event, "codex"), 0);
      assert.equal(managedCount(after.claude, event, "claude"), 0);
      assert.equal(managedCount(after.zcode, event, "zcode"), 0);
    }
    assert.equal(after.codex.hooks.Stop.at(-1).hooks[0].commandWindows, `node "${ADAPTER_PATH}.old" codex`);
    assert.equal(after.codex.hooks.Stop[0].hooks[0].command, "node retained-same-block.mjs");
    assert.equal(after.claude.hooks.Stop.at(-1).hooks[0].command, `node "${ADAPTER_PATH}-backup" claude`);
    assert.deepEqual(after.zcode.hooks.events.Stop[0].hooks[0].args, ["retained-same-group.mjs"]);
    assert.deepEqual(after.zcode.hooks.events.Stop.at(-1).hooks[0].args, [`${ADAPTER_PATH}.old`, "zcode"]);
    assert.deepEqual(after.zcode.hooks.events.UserPromptSubmit, []);
    assert.equal(await readFile(join(result.backupDir, ".codex", "hooks.json"), "utf8"), beforeUninstall.codex);
    assert.equal(await readFile(join(result.backupDir, ".claude", "settings.json"), "utf8"), beforeUninstall.claude);
    assert.equal(await readFile(join(result.backupDir, ".zcode", "cli", "config.json"), "utf8"), beforeUninstall.zcode);
  });
});

test("a rename failure leaves the existing Windows configuration unchanged and parseable", async () => {
  await withSandbox(async ({ userProfile, runtimeDir }) => {
    const claudePath = join(userProfile, ".claude", "settings.json");
    const original = "{\r\n  \"model\": \"MiniMax-M2.1\",\r\n  \"env\": { \"KEEP\": \"yes\" }\r\n}\r\n";
    await mkdir(dirname(claudePath), { recursive: true });
    await writeFile(claudePath, original, "utf8");

    await assert.rejects(
      installHooks({
        client: "claude",
        userProfile,
        runtimeDir,
        adapterPath: ADAPTER_PATH,
        renameFile: async () => {
          const error = new Error("simulated Windows sharing violation");
          error.code = "EPERM";
          throw error;
        }
      }),
      /sharing violation/
    );

    const after = await readFile(claudePath, "utf8");
    assert.equal(after, original);
    assert.doesNotThrow(() => JSON.parse(after));
    const siblings = await readdir(dirname(claudePath));
    assert.deepEqual(siblings, ["settings.json"]);
    const backupRuns = await readdir(join(runtimeDir, "backups"));
    assert.equal(backupRuns.length, 1);
    assert.equal(
      await readFile(join(runtimeDir, "backups", backupRuns[0], ".claude", "settings.json"), "utf8"),
      original
    );
  });
});

test("malformed existing JSON is rejected without backup or replacement", async () => {
  await withSandbox(async ({ userProfile, runtimeDir }) => {
    const zcodePath = join(userProfile, ".zcode", "cli", "config.json");
    const malformed = "{ this is not json";
    await mkdir(dirname(zcodePath), { recursive: true });
    await writeFile(zcodePath, malformed, "utf8");

    await assert.rejects(
      installHooks({ client: "zcode", userProfile, runtimeDir, adapterPath: ADAPTER_PATH }),
      /Invalid JSON.*config\.json/
    );

    assert.equal(await readFile(zcodePath, "utf8"), malformed);
    await assert.rejects(readdir(join(runtimeDir, "backups")), { code: "ENOENT" });
  });
});

test("sandbox preserves the primary failure when cleanup also fails and restores both environment variables", async () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const primary = new Error("primary assertion failed");
  const cleanup = new Error("cleanup failed afterward");

  await assert.rejects(
    withSandbox(async () => {
      throw primary;
    }, {
      remove: async (path, options) => {
        await rm(path, options);
        throw cleanup;
      }
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], primary);
      assert.equal(error.errors[1], cleanup);
      return true;
    }
  );
  assert.equal(process.env.HOME, originalHome);
  assert.equal(process.env.USERPROFILE, originalUserProfile);
});
