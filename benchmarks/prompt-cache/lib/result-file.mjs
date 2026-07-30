import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function writeResult(kind, payload) {
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const root = process.env.PROMPT_CACHE_BENCH_RESULT_DIR?.trim()
    || path.join(repositoryRoot, "benchmark-runs/issue-120");
  await fs.mkdir(root, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const file = path.join(root, `${stamp}-${kind}.json`);
  await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return file;
}
