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
 * variable. `cwd` is the sandbox because the repo's own tdai-gateway.yaml
 * would otherwise be found first and name a different port.
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
} finally {
  await gateway.stop();
  await llm.close();
  fs.rmSync(home, { recursive: true, force: true });
}

finish();
