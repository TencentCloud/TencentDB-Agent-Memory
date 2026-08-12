/**
 * tz-08 g6 — a registration with no address finds the gateway this machine
 * actually runs, not the one on the default port (ТЗ D1a: one memory).
 *
 * The gateway takes its port from `TDAI_GATEWAY_PORT`, then from its own yaml,
 * then from 8420. A consumer that knew only the env variable and the default
 * sent every session to 8420 — where either nothing answers, or, on a machine
 * that also runs a default gateway, ANOTHER memory answers and the note lands
 * in it. So the address rule is shared, and this probe runs the whole path with
 * no TDAI_* variable set anywhere: the configured gateway must be the one that
 * answers, and the note must be readable back from it.
 *
 * FALSIFY=default-port-only — the host is started with `TDAI_GATEWAY_PORT`
 * pointing at a port nobody listens on, which is what the old consumer's
 * blind default amounted to. The legs about reaching the configured gateway
 * must go false.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { must, finish } from "../tz07-probe/assert.mts";
import {
  freePort,
  startFakeLlm,
  startGateway,
  startHost,
  waitFor,
  writeSandboxConfig,
} from "./harness.mts";
import {
  describeAllHosts,
  resolveLauncherPath,
} from "../../src/consumer/hosts/registry.js";

const FALSIFY = process.env.FALSIFY ?? "";
const MARKER = `конфигпорт-${Date.now()}`;

const home = fs.mkdtempSync(path.join(os.tmpdir(), "tz08-g6-"));
const root = path.join(home, ".memory-tencentdb");
const dataDir = path.join(root, "memory-tdai");
fs.mkdirSync(dataDir, { recursive: true });

// The extraction carries the marker, so "the note came back" cannot be
// satisfied by anything that was already in some other memory.
const llm = await startFakeLlm((body: string) => [
  {
    scene_name: "Проверка адреса gateway",
    message_ids: ["1"],
    memories: [
      {
        content: body.includes(MARKER)
          ? `Пользователь записал заметку ${MARKER}`
          : "Заметка без маркера",
        type: "episodic",
        scope: "project",
        priority: 60,
        source_message_ids: ["1"],
      },
    ],
  },
]);

const port = await freePort();
// The gateway's OWN config, in its OWN data dir — exactly what a relocated or
// port-shifted install looks like. Nothing else will tell a client this port.
const configPath = writeSandboxConfig(path.join(dataDir, "tdai-gateway.yaml"), {
  dataDir,
  port,
  llmUrl: llm.url,
  embedding: { provider: "none" },
});
const gateway = await startGateway({ home, dataDir, port, configPath });

const launcherPath = resolveLauncherPath();

/**
 * A session's environment: this machine's root, and NOT one TDAI_GATEWAY_*
 * variable. `cwd` is the sandbox to show it makes no difference — a client
 * ignores a config in whatever directory a host happened to start it in.
 */
const sessionEnv: Record<string, string | undefined> = {
  HOME: home,
  MEMORY_TENCENTDB_ROOT: root,
  TDAI_DATA_DIR: undefined,
  TDAI_GATEWAY_URL: undefined,
  TDAI_GATEWAY_PORT:
    FALSIFY === "default-port-only" ? String(await freePort()) : undefined,
  TDAI_GATEWAY_CONFIG: undefined,
};

try {
  // The registration a user pastes on this machine: no address in it, because
  // no environment named one when it was printed.
  const descriptors = describeAllHosts({ launcherPath });
  for (const descriptor of descriptors) {
    must(
      `${descriptor.id}: в регистрации нет адреса — его находит сам сервер`,
      !descriptor.args.includes("--gateway"),
    );
  }

  const before = (await (await fetch(`${gateway.url}/status`)).json()) as {
    dataPath?: string;
  };
  console.log("gateway на порту", port, "с данными", before.dataPath);

  for (const descriptor of descriptors) {
    const host = await startHost(descriptor, { env: sessionEnv, cwd: home });
    try {
      const noted = await host.call("tools/call", {
        name: "memory_note",
        arguments: { content: `Заметка ${MARKER} от ${descriptor.id}` },
      });
      const noteResult = noted.result as { isError?: boolean };
      console.log(
        `${descriptor.id}: memory_note →`,
        JSON.stringify(noteResult).slice(0, 200),
      );
      must(
        `${descriptor.id}: заметка дошла до настроенного gateway`,
        noteResult.isError !== true,
      );

      let found = 0;
      await waitFor(
        `${descriptor.id} to read the note back`,
        async () => {
          const reply = await host.call("tools/call", {
            name: "memory_search",
            arguments: { query: MARKER, limit: 5 },
          });
          const structured = (
            reply.result as {
              structuredContent?: { total?: number; results?: string };
            }
          ).structuredContent;
          found = structured?.total ?? 0;
          return (structured?.results ?? "").includes(MARKER);
        },
        90_000,
      );
      console.log(`${descriptor.id}: memory_search нашёл ${found} записей`);
      must(`${descriptor.id}: маркер найден через тот же адрес`, found > 0);
    } finally {
      host.stop();
    }
  }

  // …and it is the CONFIGURED gateway that holds them: the marker is in its own
  // store, asked directly, without going through any wrapper.
  const direct = (await (
    await fetch(
      `${gateway.url}/memory/search?query=${encodeURIComponent(MARKER)}`,
    )
  ).json()) as { results?: string; total?: number };
  console.log("прямой запрос к gateway:", direct.total, "записей");
  must(
    "маркер лежит в памяти именно настроенного gateway",
    (direct.results ?? "").includes(MARKER),
  );

  // ── An address the host could NOT resolve for itself ──
  // The same gateway, named to the printing shell through TDAI_GATEWAY_CONFIG.
  // That variable does not reach the host, so the snippet has to carry the
  // address — otherwise the pasted line falls back to the default port and
  // answers from whatever gateway happens to run there.
  const projectDir = path.join(home, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const namedConfig = path.join(projectDir, "tdai-gateway.yaml");
  // A DECOY: the same file, but naming a port nobody listens on. If the
  // current directory were allowed to decide, the pasted line would find this
  // one instead of the gateway the user was looking at.
  const decoyPort = await freePort();
  fs.writeFileSync(
    namedConfig,
    fs
      .readFileSync(configPath, "utf-8")
      .replace(`port: ${port}`, `port: ${decoyPort}`),
    "utf-8",
  );

  const printEnv = { ...process.env, ...sessionEnv } as NodeJS.ProcessEnv;
  const printed = execFileSync(
    process.execPath,
    [launcherPath, "--host", "claude", "--print-registration"],
    {
      cwd: projectDir,
      env: { ...printEnv, TDAI_GATEWAY_CONFIG: namedConfig },
      encoding: "utf-8",
    },
  );
  must(
    "конфиг, названный переменной, попадает в снипет",
    printed.includes(`127.0.0.1:${decoyPort}`),
  );

  // A relocation variable is the same kind of answer: MEMORY_TENCENTDB_ROOT
  // moved this install, and a host started without it looks somewhere else.
  const printedRelocated = execFileSync(
    process.execPath,
    [launcherPath, "--host", "claude", "--print-registration"],
    { cwd: home, env: printEnv, encoding: "utf-8" },
  );
  must(
    "перемещённая переменной установка отдаёт адрес в снипете",
    printedRelocated.includes(`--gateway`) &&
      printedRelocated.includes(gateway.url),
  );

  // …while a config found only by being in the CURRENT DIRECTORY is not an
  // address at all: a host starts the launcher wherever it likes. Printed
  // without any relocation variable, the machine's own answer (HOME → data
  // dir) wins and the decoy in the current directory is ignored — in the
  // snippet AND at run time.
  const homeEnv = { ...printEnv, MEMORY_TENCENTDB_ROOT: undefined };
  const printedFromCwd = execFileSync(
    process.execPath,
    [launcherPath, "--host", "claude", "--print-registration"],
    { cwd: projectDir, env: homeEnv as NodeJS.ProcessEnv, encoding: "utf-8" },
  );
  must(
    "конфиг в текущем каталоге адресом не считается",
    !printedFromCwd.includes("--gateway"),
  );

  const cwdSnippet = JSON.parse(
    printedFromCwd.slice(printedFromCwd.indexOf("{")),
  ) as { mcpServers: Record<string, { command: string; args: string[] }> };
  const cwdPasted = cwdSnippet.mcpServers["tdai-memory"]!;
  const cwdHost = await startHost(
    {
      id: "claude-cwd",
      configPath: "~/.claude.json",
      command: cwdPasted.command,
      args: cwdPasted.args,
      env: {},
      registration: () => printedFromCwd,
    },
    {
      env: { ...sessionEnv, MEMORY_TENCENTDB_ROOT: undefined },
      cwd: projectDir,
    },
  );
  try {
    const reply = await cwdHost.call("tools/call", {
      name: "memory_search",
      arguments: { query: MARKER, limit: 5 },
    });
    const structured = (
      reply.result as { structuredContent?: { results?: string } }
    ).structuredContent;
    console.log(
      `хост, запущенный в каталоге с чужим конфигом (порт ${decoyPort}), нашёл маркер:`,
      (structured?.results ?? "").includes(MARKER),
    );
    must(
      "каталог не решает, в какую память попадёт сессия",
      (structured?.results ?? "").includes(MARKER),
    );
  } finally {
    cwdHost.stop();
  }

  // The gateway's REAL config, named by the variable: the address the snippet
  // carries then has to be the one the user is looking at.
  const printedReal = execFileSync(
    process.execPath,
    [launcherPath, "--host", "claude", "--print-registration"],
    {
      cwd: projectDir,
      env: { ...printEnv, TDAI_GATEWAY_CONFIG: configPath },
      encoding: "utf-8",
    },
  );
  const snippet = JSON.parse(printedReal.slice(printedReal.indexOf("{"))) as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  const pasted = snippet.mcpServers["tdai-memory"]!;
  console.log("вставляемая строка:", pasted.command, pasted.args.join(" "));
  must(
    "снипет несёт адрес, который хост сам бы не нашёл",
    pasted.args.includes("--gateway") && pasted.args.includes(gateway.url),
  );

  // …and that pasted line, run from ANOTHER directory with the same clean
  // environment, still reaches the gateway the user was looking at.
  const pastedHost = await startHost(
    {
      id: "claude-pasted",
      configPath: "~/.claude.json",
      command: pasted.command,
      args: pasted.args,
      env: {},
      registration: () => printedReal,
    },
    { env: sessionEnv, cwd: home },
  );
  try {
    const reply = await pastedHost.call("tools/call", {
      name: "memory_search",
      arguments: { query: MARKER, limit: 5 },
    });
    const structured = (
      reply.result as { structuredContent?: { results?: string } }
    ).structuredContent;
    console.log(
      "вставленная строка из другого каталога нашла:",
      (structured?.results ?? "").includes(MARKER),
    );
    must(
      "вставленная строка попала в тот же gateway",
      (structured?.results ?? "").includes(MARKER),
    );
  } finally {
    pastedHost.stop();
  }
} finally {
  await gateway.stop();
  await llm.close();
  fs.rmSync(home, { recursive: true, force: true });
}

finish();
