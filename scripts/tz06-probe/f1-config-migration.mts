/**
 * tz-06 Ф1 живая проба: гейтвей читает НЕТРОНУТЫЙ tdai-gateway.yaml этого
 * репозитория, где `piBinary`/`spawnFlags` всё ещё лежат по-старому, прямо
 * под `memory.consolidation`.
 *
 * Схема строгая (`z.strictObject`), поэтому без маппера легаси-ключей это
 * падает на старте с `unknown key(s) [piBinary, spawnFlags]` — то есть
 * переезд ключей без миграции ломает живой инстанс.
 *
 * ФАЛЬСИФИКАЦИЯ: `FALSIFY=1` парсит тот же конфиг схемой БЕЗ легаси-ключей —
 * обязана быть ошибка валидации.
 */
import { z } from "zod";
import { loadGatewayConfig } from "../../src/gateway/config.js";
import { deprecationNotice } from "../../src/gateway/consolidation/launchers/pi-config.js";

if (process.env.FALSIFY === "1") {
  // Та же строгая секция, но без принятых легаси-ключей.
  const withoutLegacy = z.strictObject({
    enabled: z.boolean().optional(),
    launchers: z.unknown().optional(),
  });
  const res = withoutLegacy.safeParse({
    enabled: true,
    piBinary: "~/.bun/bin/pi",
    spawnFlags: ["-p"],
  });
  console.log(
    `без маппера: ${
      res.success
        ? "ПРИНЯТ (дыра)"
        : `ОТКАЗ — unknown key(s) [${res.error.issues
            .flatMap((i) => ("keys" in i ? (i.keys as string[]) : []))
            .join(", ")}]`
    }`,
  );
  process.exit(0);
}

const cfg = loadGatewayConfig();
const pi = cfg.memory.consolidation.launchers.pi;
console.log(`гейтвей поднял конфиг из tdai-gateway.yaml`);
console.log(`  launchers.pi.binary = ${pi?.binary}`);
console.log(`  launchers.pi.flags  = ${JSON.stringify(pi?.flags)}`);
console.log(
  `  предупреждение: ${
    deprecationNotice(cfg.memory.consolidation.deprecatedLauncherKeys) ||
    "(нет)"
  }`,
);
