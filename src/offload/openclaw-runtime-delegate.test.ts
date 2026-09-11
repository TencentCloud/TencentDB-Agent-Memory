import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  clearOpenClawDelegateCacheForTests,
  resolveOpenClawDelegateCompactionToRuntime,
} from "./openclaw-runtime-delegate.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  clearOpenClawDelegateCacheForTests();
  for (const dir of tmpDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("resolveOpenClawDelegateCompactionToRuntime", () => {
  it("resolves openclaw/plugin-sdk from the plugin require base", async () => {
    const root = await writeFakeOpenClawSdk();

    const delegate = await resolveOpenClawDelegateCompactionToRuntime(undefined, {
      baseUrls: [join(root, "plugin-entry.cjs")],
      includeDefaultRoots: false,
    });

    await expect(delegate?.({})).resolves.toEqual({ ok: true, compacted: true });
  });

  it("resolves openclaw/plugin-sdk from an explicit module root", async () => {
    const root = await writeFakeOpenClawSdk();

    const delegate = await resolveOpenClawDelegateCompactionToRuntime(undefined, {
      baseUrls: [],
      moduleRoots: [join(root, "node_modules")],
      includeDefaultRoots: false,
    });

    await expect(delegate?.({})).resolves.toEqual({ ok: true, compacted: true });
  });

  it("returns null when the SDK cannot be found", async () => {
    const root = await mkdtemp(join(tmpdir(), "tdai-openclaw-sdk-missing-"));
    tmpDirs.push(root);

    const delegate = await resolveOpenClawDelegateCompactionToRuntime(undefined, {
      baseUrls: [join(root, "plugin-entry.cjs")],
      moduleRoots: [],
      includeDefaultRoots: false,
    });

    expect(delegate).toBeNull();
  });
});

async function writeFakeOpenClawSdk(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tdai-openclaw-sdk-"));
  tmpDirs.push(root);

  const packageDir = join(root, "node_modules", "openclaw");
  const sdkDir = join(packageDir, "dist", "plugin-sdk");
  await mkdir(sdkDir, { recursive: true });
  await writeFile(join(root, "plugin-entry.cjs"), "", "utf-8");
  await writeFakeOpenClawSdkFiles(packageDir, sdkDir);

  return root;
}

async function writeFakeOpenClawSdkFiles(packageDir: string, sdkDir: string): Promise<void> {
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({
      name: "openclaw",
      version: "0.0.0-test",
      exports: {
        "./plugin-sdk": "./dist/plugin-sdk/index.cjs",
      },
    }),
    "utf-8",
  );
  await writeFile(
    join(sdkDir, "index.cjs"),
    "exports.delegateCompactionToRuntime = async () => ({ ok: true, compacted: true });\n",
    "utf-8",
  );
}
