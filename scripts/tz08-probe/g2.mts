/**
 * tz-08 g2 (S2) — the write: one note, exactly one L0 record, found again.
 *
 * INVARIANT `nogo-l0-path`: `/memory/note` joins the existing capture path and
 * does not open a second one. Counted in the conversation log itself, not
 * inferred from the route's own answer.
 *
 * FALSIFY=double-write — the same content is also pushed through `/capture`,
 * the way a wrapper with its own write path would. The "exactly one" leg must
 * go false.
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
  describeHost,
  resolveLauncherPath,
} from "../../src/consumer/hosts/registry.js";

const FALSIFY = process.env.FALSIFY ?? "";
const MARKER = `метка-${Date.now()}`;

const home = fs.mkdtempSync(path.join(os.tmpdir(), "tz08-g2-"));
const dataDir = path.join(home, "memory", "tdai");
fs.mkdirSync(dataDir, { recursive: true });

// The fake extraction carries the marker, so "the note came back" is about
// THIS note: a fixed extraction would be found by any query about memory in
// general and would prove nothing about the write under test.
const llm = await startFakeLlm([
  {
    scene_name: "Заметка потребителя",
    message_ids: ["1"],
    memories: [
      {
        content: `Пользователь оставил заметку через обёртку: ${MARKER}`,
        type: "episodic",
        scope: "project",
        priority: 60,
        source_message_ids: ["1"],
      },
    ],
  },
]);
const port = await freePort();
const gateway = await startGateway({
  home,
  dataDir,
  port,
  configPath: writeSandboxConfig(path.join(home, "gateway.yaml"), {
    dataDir,
    port,
    llmUrl: llm.url,
  }),
});

const lookup = describeHost("claude", {
  launcherPath: resolveLauncherPath(),
  gatewayUrl: gateway.url,
});
if (!lookup.ok) throw new Error(lookup.message);
const host = await startHost(lookup.descriptor);

/** Every L0 line on disk, across whatever files the recorder made. */
function conversationText(): string {
  const dir = path.join(dataDir, "conversations");
  if (!fs.existsSync(dir)) return "";
  return fs
    .readdirSync(dir)
    .map((f) => fs.readFileSync(path.join(dir, f), "utf-8"))
    .join("");
}

try {
  const reply = await host.call("tools/call", {
    name: "memory_note",
    arguments: { content: `Заметка через обёртку: ${MARKER}` },
  });
  const written = (
    reply.result as {
      structuredContent?: { l0_recorded: number; session_key: string };
    }
  ).structuredContent;
  console.log("ответ memory_note:", JSON.stringify(written));

  if (FALSIFY === "double-write") {
    // A second write path — exactly what the invariant forbids.
    await fetch(`${gateway.url}/capture`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-memory-token": gateway.token,
      },
      body: JSON.stringify({
        user_content: `Заметка через обёртку: ${MARKER}`,
        assistant_content: "ответ второго пути",
        session_key: "второй-путь",
      }),
    });
  }

  const occurrences = conversationText().split(MARKER).length - 1;
  console.log(`вхождений метки в L0: ${occurrences}`);

  must("обёртка записала ровно одно сообщение", written?.l0_recorded === 1);
  must("в L0 ровно одно вхождение заметки", occurrences === 1);

  let found = "";
  await waitFor("the note to come back through search", async () => {
    const answer = await host.call("tools/call", {
      name: "memory_search",
      arguments: { query: MARKER, limit: 5 },
    });
    found = JSON.stringify(
      (answer.result as { structuredContent?: unknown }).structuredContent,
    );
    return found.includes(MARKER);
  });
  console.log("поиск после записи:", found);
  must(
    "заметка находится обратно штатным путём извлечения",
    found.includes(MARKER),
  );
  must("фейковая модель реально вызывалась продуктовым путём", llm.calls() > 0);
} finally {
  host.stop();
  await gateway.stop();
  await llm.close();
  fs.rmSync(home, { recursive: true, force: true });
}

finish();
