import { describe, it, expect, afterEach } from "vitest";
import {
  setCommitObserver,
  notifyCommitted,
  type MemoryMutation,
} from "./commit-port.js";

const mutation: MemoryMutation = {
  carrier: "l1",
  kind: "upsert",
  affected: 1,
  source: "test",
  at: "2026-08-11T00:00:00.000Z",
};

afterEach(() => setCommitObserver(undefined));

describe("commit-port", () => {
  it("is a no-op without an observer", () => {
    expect(() => notifyCommitted(mutation)).not.toThrow();
  });

  it("delivers the mutation to the installed observer", () => {
    const seen: MemoryMutation[] = [];
    setCommitObserver({ onCommitted: (m) => void seen.push(m) });
    notifyCommitted(mutation);
    expect(seen).toEqual([mutation]);
  });

  it("swallows a throwing observer and logs it — the mutation stands", () => {
    const warnings: string[] = [];
    setCommitObserver(
      {
        onCommitted: () => {
          throw new Error("counter store unreachable");
        },
      },
      { warn: (m) => void warnings.push(m) },
    );
    expect(() => notifyCommitted(mutation)).not.toThrow();
    expect(warnings.join("\n")).toContain("counter store unreachable");
    expect(warnings.join("\n")).toContain("mutation stands");
  });

  it("swallows a rejecting async observer too", async () => {
    const warnings: string[] = [];
    setCommitObserver(
      { onCommitted: () => Promise.reject(new Error("write failed")) },
      { warn: (m) => void warnings.push(m) },
    );
    notifyCommitted(mutation);
    await new Promise((r) => setTimeout(r, 0));
    expect(warnings.join("\n")).toContain("write failed");
  });

  it("clearing the observer restores the no-op — the package rollback path", () => {
    const seen: MemoryMutation[] = [];
    setCommitObserver({ onCommitted: (m) => void seen.push(m) });
    setCommitObserver(undefined);
    notifyCommitted(mutation);
    expect(seen).toEqual([]);
  });
});
