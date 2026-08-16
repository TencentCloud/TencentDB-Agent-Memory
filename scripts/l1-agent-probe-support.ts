import { readLatestL1Assignment } from "../src/gateway/l1/l1-status-repo.js";
import { openControlPlane } from "../src/gateway/control-plane/db.js";

export function silenceConsole(): () => void {
  const original = {
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  console.info = console.warn = console.error = console.debug = () => {};
  return () => Object.assign(console, original);
}

export async function postJson<T>(
  port: number,
  route: string,
  body: unknown,
  apiKey?: string,
): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${route} returned ${response.status}`);
  return (await response.json()) as T;
}

export async function waitForL1Commit(dataDir: string, sessionKey: string) {
  const deadline = Date.now() + 11 * 60_000;
  while (Date.now() < deadline) {
    const row = readLatestL1Assignment(dataDir, sessionKey);
    if (row?.state === "committed") return row;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("timed out waiting for committed L1 assignment");
}

export function assertProbeLines(lines: string[]): void {
  const expected = ["2", "succeeded", "1", "true", "0"];
  lines.forEach((line, index) => {
    if (!line.endsWith(`=${expected[index]}`)) throw new Error(line);
  });
}

/** Simulate a crash after store mutation but before assignment/cohort finalize. */
export function reopenL1CommitForProbe(input: {
  dataDir: string;
  assignmentId: string;
  cohortId: string;
  runId: string;
}): void {
  const db = openControlPlane(input.dataDir);
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare(
      "UPDATE l1_assignments SET state = 'committing' WHERE assignmentId = ?",
    ).run(input.assignmentId);
    db.prepare("UPDATE l1_cohorts SET state = 'open' WHERE cohortId = ?").run(
      input.cohortId,
    );
    db.prepare("UPDATE runs SET state = 'applying' WHERE runId = ?").run(
      input.runId,
    );
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}
