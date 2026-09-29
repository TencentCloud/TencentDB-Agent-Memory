import { symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isMainModule } from "./is-main-module.js";

const links: string[] = [];

afterEach(async () => {
  await Promise.all(links.splice(0).map((link) => unlink(link).catch(() => {})));
});

describe("isMainModule", () => {
  it("matches a direct ESM entry path", () => {
    const target = path.resolve("src/adapters/is-main-module.ts");
    const moduleUrl = pathToFileURL(target).href;

    expect(isMainModule(moduleUrl, target)).toBe(true);
    expect(isMainModule(moduleUrl, path.resolve("package.json"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "matches a symlinked ESM entry path",
    async () => {
      const target = path.resolve("src/adapters/is-main-module.ts");
    const link = path.join(
      tmpdir(),
      `memory-tencentdb-main-${process.pid}-${Date.now()}.ts`,
    );
    links.push(link);
    await symlink(target, link);

    const moduleUrl = pathToFileURL(target).href;
    expect(isMainModule(moduleUrl, link)).toBe(true);
    },
  );
});
