/**
 * tz-02 Ф5, тихий дроп: `keep_scratch` доезжает от role.json до контракта.
 *
 * Поле под `runtime` проходит через whitelist (`role-schema.ts`
 * `RUNTIME_KEY_CHECKS`) и через сборку `assets`
 * (`role-contract-legacy.ts:172`). Ключа нет в whitelist'е — конфиг роли
 * становится НЕвалидным целиком, и роль тихо выпадает из диспетчера: не
 * «поле проигнорировано», а «роли больше нет».
 *
 * ФАЛЬСИФИКАЦИЯ: FALSIFY=old-whitelist — то же поле под именем, которого в
 * таблице нет. Роль обязана перестать резолвиться, иначе whitelist ничего не
 * стережёт и наблюдение про `keep_scratch` ничего не значит.
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "../tz09-probe/sandbox.mts";
import { resolveRoleContract } from "../../src/gateway/consolidation/role-contract.js";

const OLD = process.env.FALSIFY === "old-whitelist";
const KEY = OLD ? "keep_scratch_unknown" : "keep_scratch";

const sbx = makeSandbox([]);
const scratchRoot = path.join(sbx.home, "role-scratch");

const roleDir = path.join(sbx.roleDir, "probe-role");
fs.mkdirSync(roleDir, { recursive: true });
fs.writeFileSync(
  path.join(roleDir, "role.json"),
  JSON.stringify(
    {
      name: "probe-role",
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
      runtime: { scratch_root: scratchRoot, [KEY]: true },
    },
    null,
    2,
  ),
  "utf-8",
);
fs.writeFileSync(path.join(roleDir, "prompt.md"), "probe prompt", "utf-8");

console.log(`FALSIFY=${process.env.FALSIFY ?? "(нет)"}`);
console.log(`ключ под runtime: ${KEY}`);

const res = resolveRoleContract("probe-role", sbx.roleDir, {
  timeoutMs: 600000,
  failOpenPromptRoles: [],
} as never);

console.log(`роль резолвится: ${res.ok} ${res.ok ? "" : `— ${res.reason}`}`);
console.log(
  `keep_scratch доехал до контракта: ` +
    `${res.ok && res.contract.assets.keepScratch === true} (должно быть true)`,
);

sbx.cleanup();
