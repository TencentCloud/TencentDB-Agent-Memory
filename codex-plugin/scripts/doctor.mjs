#!/usr/bin/env node
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  configuredGatewayTokenPath,
  ensureGateway,
  expandHome,
  gatewayUrl,
  healthCheck,
  pluginRoot,
  resolveTdaiRoot,
  tdaiDataDir,
} from "./lib.mjs";

const DEFAULT_PROFILE = "adapter-profile.json";

export async function buildAdapterDoctorReport(options = {}) {
  const root = options.pluginRoot ? path.resolve(options.pluginRoot) : pluginRoot();
  const profilePath = path.resolve(root, options.profilePath || DEFAULT_PROFILE);
  const profile = await readJson(profilePath);
  const checks = [];

  addCheck(checks, "profile_readable", Boolean(profile), { profilePath });
  addCheck(checks, "profile", Boolean(profile?.adapterId), {
    adapterId: profile?.adapterId || null,
    profilePath,
  });

  const entrypointChecks = await checkEntrypoints(root, profile);
  checks.push(...entrypointChecks);

  const hookConfigPath = path.join(root, profile.entrypoints?.hooks || "hooks/hooks.codex.json");
  const mcpConfigPath = path.join(root, profile.entrypoints?.mcp || ".mcp.json");
  const portability = await checkPortableConfigs([hookConfigPath, mcpConfigPath], root);
  checks.push(...portability);

  const dataDir = tdaiDataDir();
  const dataDirCheck = await checkDataDir(dataDir);
  checks.push(dataDirCheck);

  const url = gatewayUrl();
  const loopback = isLoopbackGatewayUrl(url);
  addCheck(checks, "gateway_loopback", loopback || process.env.TDAI_CODEX_ALLOW_NON_LOOPBACK === "true", {
    gatewayUrl: url,
    allowNonLoopback: process.env.TDAI_CODEX_ALLOW_NON_LOOPBACK === "true",
  });

  const tdaiRoot = resolveTdaiRoot();
  const sourceRootUsable = tdaiRoot ? await hasSourceGateway(tdaiRoot) : false;
  const packageSpec = process.env.TDAI_CODEX_GATEWAY_PACKAGE || profile.packageName || "@tencentdb-agent-memory/memory-tencentdb";
  addCheck(checks, "gateway_launch_source_or_package", Boolean(sourceRootUsable || packageSpec), {
    mode: sourceRootUsable ? "source-tree" : "package-bin",
    tdaiRoot,
    packageSpec,
  });

  const tokenPath = configuredGatewayTokenPath();
  addCheck(checks, "token_path_configured", Boolean(tokenPath), {
    tokenPath,
    tokenPathPrivateParent: await privateParentStatus(tokenPath),
  });

  const healthyBeforeStart = await healthCheck();
  let healthyAfterStart = healthyBeforeStart;
  if (!healthyBeforeStart && options.start === true) {
    healthyAfterStart = await ensureGateway();
  }
  addCheck(checks, options.start ? "gateway_health_after_start" : "gateway_health", options.requireHealthy ? healthyAfterStart : true, {
    healthy: healthyAfterStart,
    attemptedStart: options.start === true,
  });

  const ok = checks.every((check) => check.ok);
  return {
    ok,
    adapter: {
      id: profile?.adapterId || "unknown",
      displayName: profile?.displayName || "unknown",
      host: profile?.host || "codex",
      profilePath,
      pluginRoot: root,
    },
    runtime: {
      node: process.version,
      platform: `${os.platform()}-${os.arch()}`,
      gatewayUrl: url,
      dataDir,
      tdaiRoot,
      gatewayPackage: packageSpec,
    },
    checks,
    next: ok
      ? "Codex adapter contract looks portable. Installers can reuse this plugin root and override env vars without editing scripts."
      : "Fix failed checks before publishing or handing this adapter to another Codex environment.",
  };
}

async function checkEntrypoints(root, profile) {
  const checks = [];
  const entrypoints = profile?.entrypoints || {};
  for (const [name, relPath] of Object.entries(entrypoints)) {
    const filePath = path.resolve(root, relPath);
    addCheck(checks, `entrypoint:${name}`, fsSync.existsSync(filePath), {
      path: filePath,
      relativePath: relPath,
    });
  }
  return checks;
}

async function checkPortableConfigs(configPaths, root) {
  const checks = [];
  for (const configPath of configPaths) {
    let text = "";
    try {
      text = await fs.readFile(configPath, "utf-8");
    } catch (err) {
      addCheck(checks, `portable:${path.basename(configPath)}`, false, {
        path: configPath,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const absolutePaths = findSuspiciousAbsolutePaths(text)
      .filter((value) => !value.startsWith(root));
    addCheck(checks, `portable:${path.basename(configPath)}`, absolutePaths.length === 0, {
      path: configPath,
      suspiciousAbsolutePaths: absolutePaths,
      usesPluginRootVariable: text.includes("${PLUGIN_ROOT}") || text.includes("${CLAUDE_PLUGIN_ROOT}"),
    });
  }
  return checks;
}

async function checkDataDir(dataDir) {
  const adapterDir = path.join(dataDir, "codex-adapter");
  const details = {
    dataDir,
    adapterDir,
    created: false,
    writable: false,
    dataDirMode: null,
    adapterDirMode: null,
  };
  try {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(adapterDir, { recursive: true, mode: 0o700 });
    details.created = true;
    const probe = path.join(adapterDir, ".doctor-probe");
    await fs.writeFile(probe, "ok\n", { mode: 0o600 });
    await fs.rm(probe, { force: true });
    details.writable = true;
    details.dataDirMode = modeString(dataDir);
    details.adapterDirMode = modeString(adapterDir);
  } catch (err) {
    details.error = err instanceof Error ? err.message : String(err);
  }
  const adapterDirPrivate = details.adapterDirMode === "700";
  return {
    name: "data_dir_writable",
    ok: details.writable && adapterDirPrivate,
    details,
  };
}

async function hasSourceGateway(root) {
  if (!root) return false;
  const resolved = path.resolve(expandHome(root));
  return fsSync.existsSync(path.join(resolved, "package.json")) &&
    fsSync.existsSync(path.join(resolved, "src", "gateway", "server.ts"));
}

function findSuspiciousAbsolutePaths(text) {
  const values = new Set();
  for (const match of text.matchAll(/"(\/(?:Users|home|private|tmp|var|opt)\/[^"]+)"/g)) {
    values.add(match[1]);
  }
  return Array.from(values);
}

function isLoopbackGatewayUrl(value) {
  try {
    const url = new URL(value);
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

async function privateParentStatus(filePath) {
  const parent = path.dirname(filePath);
  if (!fsSync.existsSync(parent)) return { exists: false, mode: null };
  return { exists: true, mode: modeString(parent) };
}

function modeString(filePath) {
  try {
    return (fsSync.statSync(filePath).mode & 0o777).toString(8);
  } catch {
    return null;
  }
}

function addCheck(checks, name, ok, details = {}) {
  checks.push({ name, ok: Boolean(ok), details });
}

async function readJson(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf-8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseArgs(args) {
  const opts = {
    start: false,
    requireHealthy: false,
    strict: false,
    pretty: true,
  };

  for (const arg of args) {
    if (arg === "--start") opts.start = true;
    else if (arg === "--require-healthy") opts.requireHealthy = true;
    else if (arg === "--strict") opts.strict = true;
    else if (arg === "--json") opts.pretty = false;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return opts;
}

function usage(code = 0) {
  const message = `Usage: node scripts/doctor.mjs [--start] [--require-healthy] [--strict] [--json]

Checks whether the Codex adapter can be installed, inherited, or reused from the
current plugin root without machine-specific edits.

Options:
  --start             Attempt to start the Gateway before reporting health.
  --require-healthy   Treat Gateway health as a required check.
  --strict            Exit non-zero when any required check fails.
  --json              Print compact JSON.
`;
  (code === 0 ? console.log : console.error)(message);
  process.exit(code);
}

export async function doctorCli(args = process.argv.slice(2)) {
  const opts = parseArgs(args);
  if (opts.help) usage(0);
  const report = await buildAdapterDoctorReport(opts);
  console.log(JSON.stringify(report, null, opts.pretty ? 2 : 0));
  if (opts.strict && !report.ok) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    await doctorCli();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}
