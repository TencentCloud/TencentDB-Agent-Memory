import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { z } from "zod";
import { planReplay, replayL1, type ReplaySelection } from "../core/record/l1-replay.js";

const HELP = `replay-l1: recover historical L0 into SQLite L1 (metadata + FTS)

Required scope:
  --data-dir PATH --instance-id ID --team-id ID --user-id ID --agent-id ID
  --session-key KEY --session-id ID --task-id ID (use "" for the empty task)
Selection: --from ISO --to ISO (inclusive recorded-at range), --max-rows N (default 1000; max 10000)
Preview:   --dry-run (read-only; no model/config required)
Execute:   --apply --maintenance --fts-only --llm-config PATH [--mode chat|code]

Stop gateway/plugin writers before --apply; --maintenance acknowledges this prerequisite.
LLM config JSON: {"baseUrl":"https://example/v1","model":"model-name","apiKey":"..."}
apiKey may instead be set with REPLAY_LLM_API_KEY. Config is never printed.
This command does not create vector embeddings, JSONL mirrors, L2/L3, or move online cursors.
Keep the database and its replay journal together when backing up or restoring.
`;

export function resolveReplayDatabase(dataDir: string, instanceId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(instanceId)) throw new Error("Invalid instance ID");
  const root = realpathSync(dataDir);
  const file = instanceId === "default" ? path.join(root, "vectors.db")
    : path.join(root, "instances", instanceId, "vectors.db");
  // Fail on missing files and symlinked instance databases rather than creating or
  // accidentally opening another instance's store.
  if (realpathSync(file) !== file) throw new Error("Replay database must not use a symlink");
  return file;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({ args, options: {
    help: { type: "boolean" }, "dry-run": { type: "boolean" }, apply: { type: "boolean" },
    maintenance: { type: "boolean" }, "fts-only": { type: "boolean" },
    "data-dir": { type: "string" }, "instance-id": { type: "string" },
    "team-id": { type: "string" }, "user-id": { type: "string" }, "agent-id": { type: "string" },
    "session-key": { type: "string" }, "session-id": { type: "string" }, "task-id": { type: "string" },
    from: { type: "string" }, to: { type: "string" }, "max-rows": { type: "string" },
    "llm-config": { type: "string" }, mode: { type: "string", default: "chat" },
  } });
  if (values.help) { console.log(HELP); return; }
  if (!!values["dry-run"] === !!values.apply) throw new Error("Choose exactly one of --dry-run or --apply");
  for (const option of ["data-dir", "instance-id", "team-id", "user-id", "agent-id", "session-key", "session-id", "task-id"] as const) {
    if (values[option] === undefined) throw new Error(`Missing --${option}`);
  }
  const selection: ReplaySelection = { scope: {
    instanceId: values["instance-id"]!, teamId: values["team-id"]!, userId: values["user-id"]!,
    agentId: values["agent-id"]!, sessionKey: values["session-key"]!, sessionId: values["session-id"]!, taskId: values["task-id"]!,
  }, from: values.from, to: values.to,
    maxRows: values["max-rows"] === undefined ? undefined : Number(values["max-rows"]),
  };
  const dbPath = resolveReplayDatabase(values["data-dir"]!, selection.scope.instanceId);
  const reader = new DatabaseSync(dbPath, { readOnly: true });
  let plan;
  try { plan = planReplay(reader, selection); } finally { reader.close(); }
  if (values["dry-run"]) { console.log(JSON.stringify({ dryRun: true, scope: selection.scope, ...plan }, null, 2)); return; }
  if (!values.maintenance || !values["fts-only"]) throw new Error("Apply requires --maintenance and --fts-only; see --help");
  if (!values["llm-config"]) throw new Error("Apply requires --llm-config");
  const mode = z.enum(["chat", "code"]).parse(values.mode);
  const config = z.object({
    baseUrl: z.url(), model: z.string().min(1), apiKey: z.string().min(1),
    maxTokens: z.number().int().positive().optional(), timeoutMs: z.number().int().positive().optional(),
  }).parse({ ...JSON.parse(readFileSync(values["llm-config"], "utf8")),
    ...(process.env.REPLAY_LLM_API_KEY ? { apiKey: process.env.REPLAY_LLM_API_KEY } : {}),
  });
  // Dry-run never loads a model adapter or initializes/migrates the store.
  const [{ VectorStore }, { StandaloneLLMRunner }, { extractReplayCandidates }] = await Promise.all([
    import("../core/store/sqlite/memory-store.js"), import("../adapters/standalone/llm-runner.js"),
    import("../core/record/l1-replay-extractor.js"),
  ]);
  const store = new VectorStore(dbPath, 0);
  try {
    store.init();
    const runner = new StandaloneLLMRunner({ config, enableTools: false });
    const result = await replayL1(store, selection, (rows) => extractReplayCandidates(runner, rows, mode));
    console.log(JSON.stringify({ indexMode: "fts-only", ...result }, null, 2));
  } finally { store.close(); }
}
