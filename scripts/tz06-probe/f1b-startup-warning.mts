/**
 * tz-06 Ф1 живая проба: гейтвей САМ говорит оператору про легаси-ключи.
 *
 * pi-config.ts обещал «the gateway logs them once at startup», но писала это
 * только проба f1-config-migration — оператор боевого конфига не узнавал
 * ничего. Здесь поднимается НАСТОЯЩИЙ TdaiGateway на yaml с легаси-ключами,
 * в песочнице с изолированным HOME, и читается то, что он напечатал.
 *
 * ФАЛЬСИФИКАЦИЯ: FALSIFY=clean — тот же старт на конфиге БЕЗ легаси-ключей →
 * предупреждения быть не должно, иначе проба зеленела бы на любом старте.
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "../tz09-probe/sandbox.mts";

const CLEAN = process.env.FALSIFY === "clean";
const sbx = makeSandbox([]);

const yamlPath = path.join(sbx.home, "tdai-gateway.yaml");
const consolidation = CLEAN
  ? `    launchers:
      pi:
        binary: /home/penis/.bun/bin/pi
        flags: ["-p", "--no-context-files"]`
  : `    piBinary: /home/penis/.bun/bin/pi
    spawnFlags: ["-p", "--no-context-files", "--no-session"]`;
fs.writeFileSync(
  yamlPath,
  `data:
  baseDir: ${sbx.dataDir}
logging:
  level: info
memory:
  consolidation:
    enabled: false
${consolidation}
`,
);

// Гейтвей конструируется в ОТДЕЛЬНОМ процессе: логгер пишет в свой канал, и
// перехватывать его подменой console внутри одного процесса — это проверка
// подмены, а не продукта.
const runner = path.join(sbx.home, "boot.mts");
fs.writeFileSync(
  runner,
  `import { TdaiGateway } from "${path.resolve("src/gateway/server.ts")}";
new TdaiGateway();
`,
);

const { spawnSync } = await import("node:child_process");
const res = spawnSync("npx", ["tsx", runner], {
  cwd: sbx.home,
  env: {
    ...process.env,
    HOME: sbx.home,
    TDAI_GATEWAY_CONFIG: yamlPath,
  },
  encoding: "utf-8",
});

const out = `${res.stdout}\n${res.stderr}`;
const hits = out
  .split("\n")
  .filter((l) => l.includes("deprecated"))
  .map((l) => l.trim());
console.log(`конфиг: ${CLEAN ? "без легаси-ключей" : "с piBinary/spawnFlags"}`);
console.log(`гейтвей стартовал: exit=${res.status}`);
console.log(`предупреждений про легаси-ключи: ${hits.length}`);
for (const line of hits) console.log(`  ${line}`);

sbx.cleanup();
