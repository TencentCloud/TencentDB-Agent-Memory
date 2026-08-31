import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  clearOpenClawDelegateCacheForTests,
  resolveOpenClawDelegateCompactionToRuntime,
} from "./openclaw-runtime-delegate.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  clearOpenClawDelegateCacheForTests();
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("resolveOpenClawDelegateCompactionToRuntime", () => {
  it("resolves a CommonJS SDK from an explicit global module root", async () => {
    const root = await writeFakeSdk("commonjs");
    const delegate = await resolveOpenClawDelegateCompactionToRuntime(undefined, {
      moduleRoots: [join(root, "node_modules")],
      includeDefaults: false,
    });

    await expect(delegate?.({ source: "test" })).resolves.toEqual({ compacted: true });
  });

  it("loads an ESM-only SDK through dynamic import", async () => {
    const root = await writeFakeSdk("module");
    const delegate = await resolveOpenClawDelegateCompactionToRuntime(undefined, {
      moduleRoots: [join(root, "node_modules")],
      includeDefaults: false,
    });

    await expect(delegate?.({})).resolves.toEqual({ compacted: true });
  });

  it("derives the nvm global root from process.execPath", async () => {
    const root = await writeFakeSdk("commonjs", "prefix/lib");
    const delegate = await resolveOpenClawDelegateCompactionToRuntime(undefined, {
      execPath: join(root, "prefix", "bin", "node"),
      env: {},
      platform: "linux",
    });

    expect(delegate).toBeTypeOf("function");
  });

  it("resolves SDKs exposed through NODE_PATH", async () => {
    const root = await writeFakeSdk("commonjs");
    const delegate = await resolveOpenClawDelegateCompactionToRuntime(undefined, {
      env: { NODE_PATH: join(root, "node_modules") },
      execPath: "",
      platform: "linux",
    });

    expect(delegate).toBeTypeOf("function");
  });

  it("resolves the Windows npm global root under APPDATA", async () => {
    const root = await writeFakeSdk("commonjs", "AppData/npm");
    const delegate = await resolveOpenClawDelegateCompactionToRuntime(undefined, {
      env: { APPDATA: join(root, "AppData") },
      execPath: "",
      platform: "win32",
    });

    expect(delegate).toBeTypeOf("function");
  });

  it("continues after an invalid require base", async () => {
    const root = await writeFakeSdk("commonjs");
    const delegate = await resolveOpenClawDelegateCompactionToRuntime(undefined, {
      baseUrls: ["relative-path.cjs"],
      moduleRoots: [join(root, "node_modules")],
      includeDefaults: false,
    });

    expect(delegate).toBeTypeOf("function");
  });

  it("returns null when the SDK has no delegate export", async () => {
    const root = await writeFakeSdk("missing");
    const delegate = await resolveOpenClawDelegateCompactionToRuntime(undefined, {
      moduleRoots: [join(root, "node_modules")],
      includeDefaults: false,
    });

    expect(delegate).toBeNull();
  });
});

async function writeFakeSdk(kind: "commonjs" | "module" | "missing", moduleParent = ""): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tdai-openclaw-sdk-"));
  tmpDirs.push(root);
  const packageDir = join(root, moduleParent, "node_modules", "openclaw");
  const entry = join(packageDir, "dist", "plugin-sdk", kind === "commonjs" ? "index.cjs" : "index.js");
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(join(packageDir, "package.json"), JSON.stringify({
    name: "openclaw",
    type: kind === "commonjs" ? "commonjs" : "module",
    exports: { "./plugin-sdk": `./dist/plugin-sdk/${kind === "commonjs" ? "index.cjs" : "index.js"}` },
  }));
  const source = kind === "commonjs"
    ? "exports.delegateCompactionToRuntime = async () => ({ compacted: true });\n"
    : kind === "module"
      ? "export async function delegateCompactionToRuntime() { return { compacted: true }; }\n"
      : "export const unrelated = true;\n";
  await writeFile(entry, source);
  return root;
}
