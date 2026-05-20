#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const jobs = [
  {
    name: "migrate-sqlite-to-tcvdb",
    tsconfig: "scripts/migrate-sqlite-to-tcvdb/tsconfig.json",
    args: ["-p", "scripts/migrate-sqlite-to-tcvdb/tsconfig.json", "--noEmitOnError", "false"],
  },
  {
    name: "export-tencent-vdb",
    tsconfig: "scripts/export-tencent-vdb/tsconfig.json",
    args: ["--project", "scripts/export-tencent-vdb/tsconfig.json"],
  },
  {
    name: "read-local-memory",
    tsconfig: "scripts/read-local-memory/tsconfig.json",
    args: ["--project", "scripts/read-local-memory/tsconfig.json"],
  },
];

for (const job of jobs) {
  if (!existsSync(job.tsconfig)) {
    console.warn(`[build:scripts] skipping ${job.name}: missing ${job.tsconfig}`);
    continue;
  }

  const result = spawnSync("tsc", job.args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
