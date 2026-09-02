import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(pluginRoot, "../..");

async function readTypeScriptFiles(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  const contents: string[] = [];
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) contents.push(await readTypeScriptFiles(target));
    else if (entry.name.endsWith(".ts")) contents.push(await readFile(target, "utf8"));
  }
  return contents.join("\n");
}

describe("Cursor 独立生产包边界", () => {
  // 生产源码不得保留旧 Gateway route 或跨包源码依赖.
  it("不引用旧 Gateway 和其它 MemoryCore 源码", async () => {
    const sources = await readTypeScriptFiles(path.join(pluginRoot, "src"));

    expect(sources).not.toMatch(/(?:\/capture|\/search\/memories|\/search\/conversations|\/session\/end)/);
    expect(sources).not.toMatch(/(?:MemoryCore\/src|openclaw-plugin\/src|createMemoryFileReader)/);
  });

  // 根包必须停止发布旧 Cursor 入口, 防止形成双生产 caller.
  it("根包不再构建或发布旧 Cursor 入口", async () => {
    const rootPackage = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      bin?: Record<string, string>;
    };
    const tsdown = await readFile(path.join(repoRoot, "tsdown.config.ts"), "utf8");
    const adapterIndex = await readFile(path.join(repoRoot, "src/adapters/index.ts"), "utf8");

    expect(rootPackage.bin).not.toHaveProperty("memory-tencentdb-cursor");
    expect(tsdown).not.toContain("cursor.ts");
    expect(adapterIndex).not.toContain("./cursor/");
  });

  // 发布前必须从 clean dist 重建, 避免缺 bin 或夹带 stale 产物.
  it("prepack 会先清理并构建 dist", async () => {
    const pluginPackage = JSON.parse(await readFile(
      path.join(pluginRoot, "package.json"),
      "utf8",
    )) as { scripts?: Record<string, string> };

    expect(pluginPackage.scripts?.clean).toBeTruthy();
    expect(pluginPackage.scripts?.build).toContain("npm run clean");
    expect(pluginPackage.scripts?.prepack).toBe("npm run build");
  });
});
