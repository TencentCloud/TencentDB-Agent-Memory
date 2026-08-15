#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const [major, minor] = process.versions.node.split(".").map(Number);
const nodeSupported = major > 22 || (major === 22 && minor >= 16);
const dockerCli = spawnSync("docker", ["--version"], { encoding: "utf8" });
const dockerDaemon = dockerCli.status === 0
  ? spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" })
  : { status: 1, stdout: "", stderr: "Docker CLI unavailable" };
const dockerServerVersion = dockerDaemon.stdout.trim();
const dockerDaemonAccessible = dockerDaemon.status === 0
  && dockerServerVersion.length > 0
  && !dockerDaemon.stderr.toLowerCase().includes("permission denied");
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const localOpenclawPath = path.join(
  repositoryRoot,
  "benchmark-runs/issue-120/env/openclaw-2026.5.28/node_modules/.bin/openclaw",
);
const localOpenclawPackagePath = path.join(
  repositoryRoot,
  "benchmark-runs/issue-120/env/openclaw-2026.5.28/node_modules/openclaw/package.json",
);
let localOpenclawVersion;
try {
  localOpenclawVersion = JSON.parse(
    fs.readFileSync(localOpenclawPackagePath, "utf8"),
  ).version;
} catch {
  localOpenclawVersion = undefined;
}
const localOpenclawInstalled = fs.existsSync(localOpenclawPath)
  && typeof localOpenclawVersion === "string";
const requiredFiles = [
  "benchmarks/prompt-cache/compose.yaml",
  "benchmarks/prompt-cache/scripts/layout-benchmark.mjs",
  "benchmarks/prompt-cache/scripts/provider-benchmark.mjs",
  "benchmarks/prompt-cache/scripts/openclaw-provider-benchmark.mjs",
  "docs/issue-120/README.md",
];

const report = {
  node: {
    version: process.version,
    supported: nodeSupported,
  },
  docker: {
    cliAvailable: dockerCli.status === 0,
    cliVersion: dockerCli.status === 0 ? dockerCli.stdout.trim() : null,
    daemonAccessible: dockerDaemonAccessible,
    serverVersion: dockerDaemonAccessible ? dockerServerVersion : null,
    daemonError: dockerDaemonAccessible
      ? null
      : dockerDaemon.stderr.trim().split("\n")[0] || "Docker daemon unavailable",
  },
  files: Object.fromEntries(
    requiredFiles.map((file) => [file, fs.existsSync(path.join(repositoryRoot, file))]),
  ),
  providerEnvironment: {
    baseUrl: Boolean(process.env.PROMPT_CACHE_BENCH_BASE_URL),
    apiKey: Boolean(process.env.PROMPT_CACHE_BENCH_API_KEY),
    apiKeyFile: Boolean(process.env.PROMPT_CACHE_BENCH_API_KEY_FILE),
    model: Boolean(process.env.PROMPT_CACHE_BENCH_MODEL),
  },
  localOpenclaw: {
    installed: localOpenclawInstalled,
    version: localOpenclawVersion ?? null,
    expectedVersion: "2026.5.28",
  },
  readiness: {
    offline: nodeSupported
      && requiredFiles.every((file) => fs.existsSync(path.join(repositoryRoot, file))),
    provider: nodeSupported
      && Boolean(process.env.PROMPT_CACHE_BENCH_BASE_URL)
      && (
        Boolean(process.env.PROMPT_CACHE_BENCH_API_KEY)
        || Boolean(process.env.PROMPT_CACHE_BENCH_API_KEY_FILE)
      )
      && Boolean(process.env.PROMPT_CACHE_BENCH_MODEL),
    localOpenclawSmoke: localOpenclawInstalled
      && localOpenclawVersion === "2026.5.28",
    openclawProvider: localOpenclawInstalled
      && localOpenclawVersion === "2026.5.28"
      && (
        Boolean(process.env.PROMPT_CACHE_BENCH_API_KEY)
        || Boolean(process.env.PROMPT_CACHE_BENCH_API_KEY_FILE)
        || fs.existsSync("/tmp/issue-120-deepseek.key")
      ),
    openclawDockerSmoke: dockerCli.status === 0 && dockerDaemonAccessible,
  },
};

console.log(JSON.stringify(report, null, 2));
if (!report.readiness.offline) process.exitCode = 1;
