/**
 * tz-06 critic r4 [high] silent-degradation: роль объявляет `requires_capabilities`
 * добровольно, и ни одна живая role.json его не несёт. Значит роль с
 * `runtime.extension_path` / `runtime.skill_path` / явным `thinking` считалась
 * совместимой с ЛЮБЫМ хостом, и claude запускал её БЕЗ расширения, БЕЗ скилла и
 * БЕЗ уровня размышления, выходя с кодом 0 — «худший исход» S5: молчаливая
 * деградация вместо отказа.
 *
 * Проба берёт настоящий адаптер контракта и настоящий реестр лаунчеров и
 * спрашивает: что claude ответит на такую роль.
 *
 * ФАЛЬСИФИКАЦИЯ: FALSIFY=declared-only — считать требованиями только то, что
 * роль объявила сама (поведение до фикса). Отказ обязан исчезнуть, а argv
 * claude — оказаться без extension/skill/thinking, что и есть дефект.
 */
import { adaptRoleContract } from "../../src/gateway/consolidation/role-contract-legacy.js";
import { checkCapabilities } from "../../src/gateway/consolidation/launchers/capabilities.js";
import { claudeArgs } from "../../src/gateway/consolidation/launchers/claude.js";
import { piAssetArgs } from "../../src/gateway/consolidation/launchers/pi.js";
import type { RoleConfigFile } from "../../src/gateway/role-schema.js";
import type { LaunchInput } from "../../src/gateway/consolidation/launchers/types.js";

const DECLARED_ONLY = process.env.FALSIFY === "declared-only";

const cfg = {
  name: "memory-keeper",
  model: "anthropic/sonnet",
  thinking: "high",
  runtime: {
    extension_path: "/roles/keeper/ext.ts",
    skill_path: "/roles/keeper/skills",
  },
} as unknown as RoleConfigFile;

const contract = adaptRoleContract({
  role: "memory-keeper",
  cfg,
  missing: [],
  legacy: {
    model: "m",
    thinking: "low",
    timeoutMs: 600_000,
    diffCap: 20,
    diffByteCap: 8192,
    night: {},
    failOpenPromptRoles: [],
  } as never,
  promptPath: null,
  promptText: null,
  source: "legacy",
});

const required = DECLARED_ONLY
  ? [...(cfg.requires_capabilities ?? [])]
  : contract.requiresCapabilities;

console.log(`FALSIFY=${process.env.FALSIFY ?? "(нет)"}`);
console.log(
  `роль реально использует: extension_path, skill_path, thinking=high`,
);
console.log(`контракт требует: ${JSON.stringify(required)}`);

// Настоящие наборы возможностей хостов — через тот же checkCapabilities,
// которым решает пайплайн.
const CLAUDE = new Set(["session", "tool-subset"]);
const err = checkCapabilities("claude", required, CLAUDE);
console.log(
  `claude отказал: ${err !== null} (должно быть true)` +
    (err === null ? "" : `\n  ${err.message}`),
);

// Что claude ЗАПУСТИЛ БЫ, если бы его не остановили.
const input = {
  cwd: "/tmp/x",
  taskPrompt: "TASK",
  contract,
} as unknown as LaunchInput;
const argv = claudeArgs(
  { binary: "claude", flags: ["-p"] },
  input,
  "sid",
  "SYS",
);
console.log(`argv claude: ${JSON.stringify(argv)}`);
console.log(
  `в argv claude есть расширение/скилл/thinking: ` +
    `${argv.some((a) => /ext\.ts|skills|high/.test(a))} (должно быть false)`,
);
console.log(
  `для сравнения, pi передаёт: ${JSON.stringify(piAssetArgs(contract))}`,
);
