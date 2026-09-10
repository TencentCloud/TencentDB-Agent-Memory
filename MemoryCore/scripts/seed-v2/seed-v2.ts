#!/usr/bin/env node

/**
 * CLI client for the gateway's legacy-compatible POST /seed endpoint.
 *
 * The command intentionally stays transport-only: validation, normalization,
 * pipeline execution, and output-directory management belong to MemoryCore's
 * shared gateway seed implementation. Keeping those responsibilities on the
 * server also means this utility works against both local and remote gateways.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const DEFAULT_ENDPOINT = "http://127.0.0.1:18420";
const DEFAULT_SERVICE_ID = "default";
const DEFAULT_TIMEOUT_MS = 300_000;

export interface SeedCliOptions {
  input: string;
  endpoint: string;
  apiKey: string;
  serviceId: string;
  sessionKey?: string;
  strictRoundRole: boolean;
  autoFillTimestamps: boolean;
  configFile?: string;
  timeoutMs: number;
}

export interface SeedRequest {
  data: unknown;
  session_key?: string;
  strict_round_role?: boolean;
  auto_fill_timestamps?: boolean;
  config_override?: Record<string, unknown>;
}

export interface SeedResponse {
  sessions_processed: number;
  rounds_processed: number;
  messages_processed: number;
  l0_recorded: number;
  duration_ms: number;
  output_dir: string;
}

interface HelpOptions {
  help: true;
}

export type ParsedSeedArgs = SeedCliOptions | HelpOptions;

export class SeedCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedCliError";
  }
}

type CliValue = string | boolean | Array<string | boolean> | undefined;

const HELP_TEXT = `
Seed historical conversations through the MemoryCore gateway.

Usage:
  npm run seed-v2 -- --input <file> [options]
  node ./bin/seed-v2.mjs --input <file> [options]

Required:
  --input <path>                 Input JSON file (Format A or Format B)

Options:
  --endpoint <url>               Gateway URL (default: ${DEFAULT_ENDPOINT})
  --api-key <key>                Gateway Bearer key (or TDAI_GATEWAY_API_KEY)
  --service-id <id>              Memory service ID header (default: default)
  --session-key <key>            Fallback session key for input sessions
  --strict-round-role            Require user and assistant in every round
  --no-auto-fill-timestamps      Reject input messages without timestamps
  --config <path>                JSON config overrides for the gateway seed run
  --timeout-ms <ms>              Request timeout (default: ${DEFAULT_TIMEOUT_MS})
  -h, --help                     Show this help

Examples:
  npm run seed-v2 -- --input ./scripts/seed-v2/fixtures/minimal.json
  node ./bin/seed-v2.mjs --input conversations.json --endpoint http://127.0.0.1:8420
`.trimStart();

function singleValue(value: CliValue, name: string): string | boolean | undefined {
  if (Array.isArray(value)) {
    throw new SeedCliError(`--${name} may only be specified once.`);
  }
  return value;
}

function stringValue(value: CliValue, name: string): string {
  value = singleValue(value, name);
  if (typeof value !== "string" || value.trim() === "") {
    throw new SeedCliError(`Missing required value for --${name}.\n\n${HELP_TEXT}`);
  }
  return value.trim();
}

function optionalStringValue(value: CliValue, name = "option"): string | undefined {
  value = singleValue(value, name);
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.trim();
}

function parsePositiveInteger(value: CliValue, name: string, fallback: number): number {
  value = singleValue(value, name);
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new SeedCliError(`--${name} must be a positive integer.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new SeedCliError(`--${name} must be a positive integer.`);
  }
  return parsed;
}

function normalizeEndpoint(rawEndpoint: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    throw new SeedCliError(`Invalid --endpoint URL: ${rawEndpoint}`);
  }

  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new SeedCliError(`--endpoint must use http:// or https://: ${rawEndpoint}`);
  }

  return endpoint.toString().replace(/\/+$/, "");
}

export function parseSeedCliArgs(argv: string[]): ParsedSeedArgs {
  let values: ReturnType<typeof parseArgs>["values"];
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      allowNegative: true,
      options: {
        input: { type: "string", short: "i" },
        endpoint: { type: "string" },
        "api-key": { type: "string" },
        "service-id": { type: "string" },
        "session-key": { type: "string" },
        "strict-round-role": { type: "boolean" },
        "auto-fill-timestamps": { type: "boolean" },
        config: { type: "string" },
        "timeout-ms": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SeedCliError(`${message}\n\n${HELP_TEXT}`);
  }

  if (values.help === true) return { help: true };

  const input = stringValue(values.input, "input");
  const endpoint = normalizeEndpoint(
    optionalStringValue(values.endpoint, "endpoint") ?? (process.env.TDAI_GATEWAY_URL?.trim() || DEFAULT_ENDPOINT),
  );
  const apiKey = optionalStringValue(values["api-key"], "api-key") ?? (process.env.TDAI_GATEWAY_API_KEY?.trim() || "");
  const serviceId =
    optionalStringValue(values["service-id"], "service-id") ?? (process.env.TDAI_SERVICE_ID?.trim() || DEFAULT_SERVICE_ID);
  const strictRoundRole = singleValue(values["strict-round-role"], "strict-round-role") === true;
  const autoFillTimestamps = singleValue(values["auto-fill-timestamps"], "auto-fill-timestamps") !== false;

  return {
    input,
    endpoint,
    apiKey,
    serviceId,
    sessionKey: optionalStringValue(values["session-key"], "session-key"),
    strictRoundRole,
    autoFillTimestamps,
    configFile: optionalStringValue(values.config, "config"),
    timeoutMs: parsePositiveInteger(values["timeout-ms"], "timeout-ms", DEFAULT_TIMEOUT_MS),
  };
}

async function readJsonFile(filePath: string, label: string): Promise<unknown> {
  const resolvedPath = path.resolve(filePath);
  let raw: string;
  try {
    raw = await fs.readFile(resolvedPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SeedCliError(`Unable to read ${label} file ${resolvedPath}: ${message}`);
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SeedCliError(`Invalid JSON in ${label} file ${resolvedPath}: ${message}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readConfigOverride(filePath: string | undefined): Promise<Record<string, unknown> | undefined> {
  if (!filePath) return undefined;

  const raw = await readJsonFile(filePath, "config override");
  if (!isRecord(raw)) {
    throw new SeedCliError(`Config override must contain a JSON object: ${path.resolve(filePath)}`);
  }
  return raw;
}

export function buildSeedRequest(
  data: unknown,
  options: Pick<SeedCliOptions, "sessionKey" | "strictRoundRole" | "autoFillTimestamps">,
  configOverride?: Record<string, unknown>,
): SeedRequest {
  const request: SeedRequest = { data };
  if (options.sessionKey) request.session_key = options.sessionKey;
  if (options.strictRoundRole) request.strict_round_role = true;
  if (!options.autoFillTimestamps) request.auto_fill_timestamps = false;
  if (configOverride) request.config_override = configOverride;
  return request;
}

function responseSummary(payload: unknown): string {
  if (!isRecord(payload)) return String(payload);

  const fields = ["error", "message", "detail"]
    .map((key) => payload[key])
    .filter((value): value is string => typeof value === "string" && value.trim() !== "");
  if (fields.length > 0) return fields.join("; ");

  try {
    return JSON.stringify(payload);
  } catch {
    return "Unknown gateway response";
  }
}

function unwrapGatewayResponse(payload: unknown): unknown {
  if (!isRecord(payload) || typeof payload.code !== "number") return payload;
  if (payload.code !== 0) {
    throw new SeedCliError(`Gateway rejected seed request (code ${payload.code}): ${responseSummary(payload)}`);
  }
  return payload.data ?? {};
}

export async function postSeedRequest(options: SeedCliOptions, request: SeedRequest): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const url = `${options.endpoint}/seed`;

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey || "local"}`,
          "Content-Type": "application/json",
          "x-tdai-service-id": options.serviceId,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new SeedCliError(`Gateway request timed out after ${options.timeoutMs} ms: ${url}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new SeedCliError(`Unable to reach gateway at ${url}: ${message}`);
    }

    const rawBody = await response.text();
    let payload: unknown;
    try {
      payload = rawBody ? JSON.parse(rawBody) as unknown : {};
    } catch {
      throw new SeedCliError(`Gateway returned non-JSON response (HTTP ${response.status}).`);
    }

    if (!response.ok) {
      throw new SeedCliError(`Gateway returned HTTP ${response.status}: ${responseSummary(payload)}`);
    }

    return unwrapGatewayResponse(payload);
  } finally {
    clearTimeout(timeout);
  }
}

function printResult(result: unknown): void {
  if (isRecord(result) &&
      typeof result.sessions_processed === "number" &&
      typeof result.rounds_processed === "number" &&
      typeof result.messages_processed === "number") {
    console.log("\n✅ Seed complete");
    console.log(`   Sessions: ${result.sessions_processed}`);
    console.log(`   Rounds:   ${result.rounds_processed}`);
    console.log(`   Messages: ${result.messages_processed}`);
    if (typeof result.l0_recorded === "number") console.log(`   L0:       ${result.l0_recorded}`);
    if (typeof result.duration_ms === "number") console.log(`   Duration: ${(result.duration_ms / 1000).toFixed(1)}s`);
    if (typeof result.output_dir === "string") console.log(`   Output:   ${result.output_dir}`);
    return;
  }

  console.log(JSON.stringify(result, null, 2));
}

export async function runSeedCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseSeedCliArgs(argv);
  if ("help" in parsed) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const data = await readJsonFile(parsed.input, "input");
  const configOverride = await readConfigOverride(parsed.configFile);
  const request = buildSeedRequest(data, parsed, configOverride);

  console.log(`📤 Seeding ${path.resolve(parsed.input)} via ${parsed.endpoint}/seed`);
  const result = await postSeedRequest(parsed, request);
  printResult(result);
}

function isInvokedAsEntryPoint(): boolean {
  const currentFile = path.resolve(fileURLToPath(import.meta.url));
  const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
  return currentFile.toLowerCase() === invokedFile.toLowerCase();
}

if (isInvokedAsEntryPoint()) {
  runSeedCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ ${message}`);
    process.exitCode = 1;
  });
}
