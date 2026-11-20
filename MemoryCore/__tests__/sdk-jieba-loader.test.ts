import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const packageRequire = createRequire(path.join(root, "package.json"));
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const enabled = process.platform === "linux" && process.arch === "x64";
const invoke = (cwd: string, code: string) => spawnSync(process.execPath, ["--input-type=module", "-e", code], {
  cwd, env: { ...process.env, NAPI_RS_ENFORCE_VERSION_CHECK: "1" }, encoding: "utf8", timeout: 120_000,
});

describe.skipIf(!enabled)("real SDK Jieba version enforcement", () => {
  it("encodes Chinese and English documents and queries without modifying official dependencies", () => {
    const loaderPath = packageRequire.resolve("@node-rs/jieba");
    const before = readFileSync(loaderPath);
    const result = invoke(root, `
      import assert from 'node:assert/strict';
      import { BM25Encoder } from '#tcvdb-text';
      for (const language of ['zh', 'en']) {
        const encoder = BM25Encoder.default(language);
        const text = language === 'zh' ? '中国城市记忆测试' : 'ordinary language memory';
        for (const vectors of [encoder.encodeTexts([text]), encoder.encodeQueries([text])]) {
          assert(vectors.length > 0);
          assert(vectors.every(v => v.length > 0 && v.every(p => p.length === 2 && Number.isInteger(p[0]) && Number.isFinite(p[1]))));
        }
      }
      console.log('SDK strict encoding PASS');
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("SDK strict encoding PASS");
    expect(readFileSync(loaderPath)).toEqual(before);
  });

  it("rejects mismatched native metadata through the SDK route in a copied fixture", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sdk-jieba-mismatch-")); temporary.push(dir);
    mkdirSync(path.join(dir, "vendor"));
    cpSync(path.join(root, "vendor/tcvdb-text"), path.join(dir, "vendor/tcvdb-text"), { recursive: true });
    cpSync(path.join(root, "vendor/jieba-loader.cjs"), path.join(dir, "vendor/jieba-loader.cjs"));
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module", imports: {
      "#tcvdb-text": "./vendor/tcvdb-text/dist/index.js", "#jieba-loader": "./vendor/jieba-loader.cjs",
    }}));
    const scope = path.join(dir, "node_modules/@node-rs"); mkdirSync(scope, { recursive: true });
    for (const name of ["jieba", "jieba-linux-x64-gnu"]) {
      cpSync(path.dirname(packageRequire.resolve(`@node-rs/${name}/package.json`)), path.join(scope, name), { recursive: true });
    }
    const metadataPath = path.join(scope, "jieba-linux-x64-gnu/package.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    writeFileSync(metadataPath, JSON.stringify({ ...metadata, version: "9.9.9" }));
    const sdkScope = path.join(dir, "node_modules/@tencentdb-agent-memory"); mkdirSync(sdkScope, { recursive: true });
    // Data resolution is not reached on failure, but keep the fixture otherwise complete.
    symlinkSync(path.join(root, "node_modules/@tencentdb-agent-memory/tcvdb-text"), path.join(sdkScope, "tcvdb-text"), "dir");
    symlinkSync(path.dirname(packageRequire.resolve("murmurhash/package.json")), path.join(dir, "node_modules/murmurhash"), "dir");
    const result = invoke(dir, `await import('#tcvdb-text');`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("expected 2.0.3 but got 9.9.9");
    expect(JSON.parse(readFileSync(packageRequire.resolve("@node-rs/jieba-linux-x64-gnu/package.json"), "utf8")).version).toBe("2.0.3");
  });
});
