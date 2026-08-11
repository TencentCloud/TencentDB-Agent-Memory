/**
 * tz-07 Ф2, критерий 3: установка со СТАРЫМ корнем продолжает работать, но
 * писать начинает в новый.
 *
 * Четыре условия из кристалла §2.2, дословно:
 *   (а) роли и промпты ПРОЧИТАНЫ со старого пути;
 *   (б) в stderr есть deprecation;
 *   (в) первая новая запись легла под НОВЫЙ корень;
 *   (г) старый каталог после прогона байт в байт прежний.
 *
 * (в) — намеренное per-install расщепление: старый корень становится
 * read-only источником, а не вторым местом записи. Без (г) это было бы не
 * отличить от «мы просто ещё не трогали старый каталог».
 *
 * ФАЛЬСИФИКАЦИЯ: FALSIFY=writable-legacy — писать туда, куда указал fallback.
 * (в) и (г) обязаны покраснеть; если они остаются зелёными, проба не смотрит
 * на запись и первая половина ничего не доказывает.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  allowLegacyFallback,
  defaultTdaiRoot,
  legacyReadPath,
  resetTdaiRootCacheForTests,
  resolveUnderRoot,
} from "../../src/gateway/tdai-root.js";
import {
  loadRoleConfig,
  loadRolePrompt,
} from "../../src/gateway/role-files.js";
import { must, finish } from "./assert.mts";

const WRITABLE_LEGACY = process.env.FALSIFY === "writable-legacy";
const ROLE = "memory-keeper";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "tz07-p2-home-"));
const root = path.join(home, "new-root");
process.env.HOME = home;
process.env.TDAI_DATA_DIR = root;
resetTdaiRootCacheForTests();
// Это РЕАЛЬНАЯ установка, а не песочница: композиционный корень объявляет
// её, как это делает server.ts/index.ts. Без объявления fallback не даётся —
// в том и смысл правила.
allowLegacyFallback(root);

console.log(`FALSIFY=${process.env.FALSIFY ?? "(нет)"}`);
console.log(`старый корень: ${path.join(home, ".pi/agent-memory/tdai")}`);
console.log(`новый корень:  ${root}`);

// Установка «как была до tz-07»: роли лежат только под ~/.pi.
const legacyRole = path.join(
  home,
  ".pi",
  "agent-memory",
  "tdai",
  "roles",
  ROLE,
);
fs.mkdirSync(legacyRole, { recursive: true });
fs.writeFileSync(
  path.join(legacyRole, "role.json"),
  JSON.stringify(
    {
      name: ROLE,
      model: "opencode-go/deepseek-v4-flash",
      prompt_file: "prompt.md",
      enabled: true,
      thinking: "low",
      timeout_min: 10,
      scope: "fresh_tail",
      trigger: "manual_only",
      schedule: null,
      threshold: null,
      idsOnly: false,
      diff_cap: 20,
      diff_byte_cap: 8192,
      ops_subset: ["deleteL1"],
      tools_subset: [],
      caps: { delete_per_run: 10, rewrite_per_run: 10 },
      max_run_ms: 600000,
      fail_on_missing_prompt: false,
      critic_role: null,
    },
    null,
    2,
  ),
  "utf-8",
);
fs.writeFileSync(
  path.join(legacyRole, "prompt.md"),
  "СТАРЫЙ ПРОМПТ\n",
  "utf-8",
);
fs.mkdirSync(root, { recursive: true });

const hashTree = (dir: string): string => {
  const h = createHash("sha256");
  const walk = (d: string): void => {
    for (const e of fs
      .readdirSync(d, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, e.name);
      h.update(path.relative(dir, full));
      if (e.isDirectory()) walk(full);
      else h.update(fs.readFileSync(full));
    }
  };
  walk(dir);
  return h.digest("hex");
};

const legacyRoot = path.join(home, ".pi", "agent-memory", "tdai");
const before = hashTree(legacyRoot);

// --- (а) и (б) --------------------------------------------------------------
const stderrLines: string[] = [];
const realWrite = process.stderr.write.bind(process.stderr);
// @ts-expect-error — перехват на время чтения.
process.stderr.write = (chunk: string | Uint8Array): boolean => {
  stderrLines.push(String(chunk));
  return true;
};
const cfg = loadRoleConfig(ROLE, root);
const prompt = loadRolePrompt(ROLE, root);
// @ts-expect-error — вернуть как было.
process.stderr.write = realWrite;

const a = cfg?.name === ROLE && prompt === "СТАРЫЙ ПРОМПТ\n";
const b = stderrLines.some((l) => l.includes("DEPRECATED"));

// --- (в) --------------------------------------------------------------------
// Первая новая запись: роль пишет свой prompt.md заново.
const target = WRITABLE_LEGACY
  ? path.join(legacyReadPath(root, "roles"), ROLE, "prompt.md")
  : path.join(resolveUnderRoot(root, "roles"), ROLE, "prompt.md");
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, "НОВЫЙ ПРОМПТ\n", "utf-8");

const v = target.startsWith(root + path.sep);
const g = hashTree(legacyRoot) === before;

must("(а) прочитано со старого пути", a);
must("(б) deprecation в stderr", b);
must("(в) запись легла под новый корень", v);
must("(г) старый каталог не изменился", g);
console.log(`   писали в: ${target}`);
console.log(`дефолтный корень резолвится в: ${defaultTdaiRoot()}`);

fs.rmSync(home, { recursive: true, force: true });

finish();
