/**
 * tz-02 критерии 2, 3 (S2): корень scratch берётся из instance-конфига, а не
 * из выражения, зашитого в `server.ts`.
 *
 * Проба гоняет ЖИВОЙ гейтвей и настоящий ручной прогон роли, потому что
 * вопрос ровно в том, куда попадут артефакты попытки, а не в том, что
 * написано в коде. Ног две:
 *   A — у роли нет `runtime.scratch_root`: работает общий корень, заданный
 *       `data.scratchRoot` в yaml;
 *   B — у роли `runtime.scratch_root` есть: legacy-переопределение обязано
 *       по-прежнему выигрывать (run-role.ts:66), иначе Ф3 ломает рабочие роли.
 *
 * ФАЛЬСИФИКАЦИЯ: FALSIFY=hardcoded-root — проба ищет артефакты там, куда их
 * клал прежний хардкод (`<dirname(dataDir)>/tdai-memory-keeper`). «Артефакты в
 * заданном корне» обязано стать false на ОБЕИХ ногах. (Второе наблюдение при
 * этом смотрит на тот же самый каталог и остаётся true — это тавтология, а не
 * подтверждение.)
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "../tz09-probe/sandbox.mts";
import { TdaiGateway } from "../../src/gateway/server.js";

const HARDCODED = process.env.FALSIFY === "hardcoded-root";
/** makeSandbox копирует живые роли из os.homedir(), а тот читает $HOME —
 * который первая же нога переставляет в песочницу. Держим настоящий. */
const REAL_HOME = process.env.HOME ?? "";
const ROLE = "memory-keeper";

/** Есть ли под корнем хоть один паспорт попытки (`<runId>/run.json`). */
function passportUnder(root: string): string | null {
  if (!fs.existsSync(root)) return null;
  for (const dir of fs.readdirSync(root)) {
    const p = path.join(root, dir, "run.json");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function leg(
  label: string,
  port: number,
  roleScratchRoot: string | null,
): Promise<void> {
  process.env.HOME = REAL_HOME;
  const sbx = makeSandbox([ROLE]);
  process.env.HOME = sbx.home;

  const roleFile = path.join(sbx.roleDir, ROLE, "role.json");
  if (!fs.existsSync(roleFile)) {
    console.log(`${label}: живой роли ${ROLE} нет — нога пропущена`);
    sbx.cleanup();
    return;
  }
  const role = JSON.parse(fs.readFileSync(roleFile, "utf-8")) as {
    runtime?: Record<string, unknown>;
  };
  const runtime = role.runtime ?? {};
  // makeSandbox всегда проставляет scratch_root; ногу A он бы и накрыл.
  if (roleScratchRoot === null) delete runtime.scratch_root;
  else runtime.scratch_root = roleScratchRoot;
  role.runtime = runtime;
  fs.writeFileSync(roleFile, JSON.stringify(role, null, 2), "utf-8");

  const configured = path.join(sbx.home, "configured-scratch");
  const oldDefault = path.join(path.dirname(sbx.dataDir), "tdai-memory-keeper");
  const cfgPath = path.join(sbx.home, "tdai-gateway.yaml");
  fs.writeFileSync(
    cfgPath,
    [
      "server:",
      "  host: 127.0.0.1",
      `  port: ${port}`,
      "data:",
      `  baseDir: ${sbx.dataDir}`,
      `  scratchRoot: ${configured}`,
      "memory:",
      "  consolidation:",
      "    enabled: true",
    ].join("\n"),
    "utf-8",
  );
  process.env.TDAI_GATEWAY_CONFIG = cfgPath;

  const gateway = new TdaiGateway();
  await gateway.start();
  const tokenFile = path.join(path.dirname(sbx.dataDir), "tdai-gateway.token");
  const token = fs.existsSync(tokenFile)
    ? fs.readFileSync(tokenFile, "utf-8").trim()
    : "";
  const res = await fetch(`http://127.0.0.1:${port}/memory/run`, {
    method: "POST",
    headers: { "x-memory-token": token, "content-type": "application/json" },
    body: "{}",
  });
  console.log(`${label}: POST /memory/run -> ${res.status}`);

  // Паспорт пишется ДО спавна ребёнка, поэтому ждём его, а не исхода прогона:
  // ребёнок в песочнице без кредов всё равно умрёт.
  const expected = roleScratchRoot ?? configured;
  const wanted = HARDCODED ? oldDefault : expected;
  const deadline = Date.now() + 20_000;
  let found: string | null = null;
  while (Date.now() < deadline && found === null) {
    found = passportUnder(wanted);
    if (found === null) await new Promise((r) => setTimeout(r, 500));
  }
  await gateway.stop();

  console.log(`${label}: искали в ${wanted}`);
  console.log(
    `${label}: артефакты в заданном корне: ${found !== null} (должно быть true)`,
  );
  console.log(
    `${label}: в прежнем месте пусто: ` +
      `${passportUnder(oldDefault) === null} (должно быть true)`,
  );
  sbx.cleanup();
}

console.log(`FALSIFY=${process.env.FALSIFY ?? "(нет)"}`);
await leg("A (корень из конфига)", 8794, null);
const legacyRoot = path.join(
  fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "tz02-legacy-")),
  "role-scratch",
);
await leg("B (legacy runtime.scratch_root)", 8795, legacyRoot);
fs.rmSync(path.dirname(legacyRoot), { recursive: true, force: true });
