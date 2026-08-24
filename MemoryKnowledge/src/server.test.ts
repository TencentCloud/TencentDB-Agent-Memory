import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test("exits after a startup failure when Langfuse telemetry is enabled", async () => {
  const invalidDbPath = await mkdtemp(join(tmpdir(), "knowledge-db-directory-"));
  temporaryDirectories.push(invalidDbPath);

  const result = await runServerProcess(invalidDbPath);

  expect(result.output).toContain("Knowledge service failed to start");
  expect(result.code).toBe(1);
}, 10_000);

function runServerProcess(
  invalidDbPath: string,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--eval",
        'import("./src/server.ts").then(({ runServer }) => runServer())',
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: {
          ...process.env,
          KNOWLEDGE_DB_PATH: invalidDbPath,
          LANGFUSE_SECRET_KEY: "test-secret",
          LANGFUSE_PUBLIC_KEY: "test-public",
          LANGFUSE_BASE_URL: "http://127.0.0.1:9",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`server process did not exit after startup failure:\n${output}`));
    }, 5_000);

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, output });
    });
  });
}
