import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tarball = resolve(
  process.argv[2]
    ?? readdirSync(repositoryRoot).find((name) => name.endsWith(".tgz"))
    ?? "missing-package.tgz",
);
const temporaryRoot = mkdtempSync(join(tmpdir(), "memory-tencentdb-packed-"));
const packageRoot = join(
  temporaryRoot,
  "node_modules",
  "@tencentdb-agent-memory",
  "memory-tencentdb",
);

function run(executable, args, cwd = temporaryRoot) {
  execFileSync(executable, args, { cwd, stdio: "inherit" });
}

try {
  run("tar", ["-xzf", tarball, "-C", temporaryRoot]);
  const installedPackageRoot = packageRoot;
  run("node", [
    "-e",
    [
      "const fs=require('node:fs'),path=require('node:path');",
      `const source=${JSON.stringify(join(temporaryRoot, "package"))};`,
      `const target=${JSON.stringify(installedPackageRoot)};`,
      "fs.mkdirSync(path.dirname(target),{recursive:true});",
      "fs.cpSync(source,target,{recursive:true});",
    ].join(""),
  ]);
  run("node", [
    "--input-type=module",
    "-e",
    [
      "const gateway = await import('@tencentdb-agent-memory/memory-tencentdb/adapters/gateway-client');",
      "const mimo = await import('@tencentdb-agent-memory/memory-tencentdb/adapters/mimo-code');",
      "if (typeof gateway.GatewayMemoryClient !== 'function') process.exit(1);",
      "if (typeof mimo.createMimoCodeMemoryPlugin !== 'function') process.exit(1);",
    ].join(" "),
  ]);

  const consumerPath = join(temporaryRoot, "consumer.mts");
  writeFileSync(consumerPath, `
import {
  GatewayMemoryClient,
  GatewayResponseError,
  createGatewayPlatformAdapter,
} from "@tencentdb-agent-memory/memory-tencentdb/adapters/gateway-client";
import {
  createMimoCodeMemoryPlugin,
  type MimoCodePluginHooks,
} from "@tencentdb-agent-memory/memory-tencentdb/adapters/mimo-code";

const client = new GatewayMemoryClient();
const adapter = createGatewayPlatformAdapter({
  client,
  platform: "type-smoke",
  resolveContext: () => ({ sessionKey: "smoke" }),
});
const hooks: Promise<MimoCodePluginHooks> = createMimoCodeMemoryPlugin()({
  directory: ".",
});
void adapter;
void hooks;
void GatewayResponseError;
`);

  const typescriptBin = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
  run("node", [
    typescriptBin,
    "--noEmit",
    "--strict",
    "--target", "ES2022",
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--skipLibCheck", "false",
    consumerPath,
  ]);

  const manifest = JSON.parse(readFileSync(join(temporaryRoot, "package", "package.json"), "utf8"));
  if (!manifest.exports?.["./adapters/gateway-client"]?.types) {
    throw new Error("Packed Gateway adapter export has no types condition");
  }
  if (!manifest.exports?.["./adapters/mimo-code"]?.types) {
    throw new Error("Packed MiMo adapter export has no types condition");
  }
  console.log("PACKED_ADAPTER_SMOKE_OK");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
