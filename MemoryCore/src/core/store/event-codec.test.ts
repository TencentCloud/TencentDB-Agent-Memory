import { describe, expect, it } from "vitest";
import { decodeMemoryEvent, parseSupersedesJson } from "./event-codec.js";
import { canonRecordInstants } from "./memory-event-id.js";

describe("decodeMemoryEvent", () => {
  it("decodes empty/missing optional fields to undefined and defaults layer/version", () => {
    const e = decodeMemoryEvent({ event_ts: "2026-03-01T10:00:00.000Z", op: "created", record_id: "m", content: "c", team_id: "", layer: "" }, []);
    expect(e).toEqual({
      event_id: undefined, event_ts: "2026-03-01T10:00:00.000Z", session_key: "", session_id: "",
      origin_session_id: undefined, origin_session_key: undefined, team_id: undefined, user_id: undefined,
      agent_id: undefined, task_id: undefined, op: "created", record_id: "m", content: "c", memory_type: undefined,
      version: 0, supersedes: undefined, superseded_by: undefined, snapshot_json: undefined, reviewer_id: undefined,
      layer: "l1", source: undefined, request_id: undefined, reason: undefined, target_event_id: undefined,
      scope: undefined, until: undefined,
    });
  });

  it("passes populated fields through and keeps non-empty supersedes", () => {
    const e = decodeMemoryEvent({ event_id: "evt-1", version: 3, layer: "l2", source: "review", until: "2026-03-01T00:00:00.000Z" }, ["m_a"]);
    expect(e).toMatchObject({ event_id: "evt-1", version: 3, layer: "l2", source: "review", supersedes: ["m_a"], until: "2026-03-01T00:00:00.000Z" });
  });
});

describe("parseSupersedesJson", () => {
  it("parses JSON arrays and treats malformed input as none", () => {
    expect(parseSupersedesJson("[\"m_a\"]")).toEqual(["m_a"]);
    expect(parseSupersedesJson("{not json")).toEqual([]);
  });
});

describe("canonRecordInstants", () => {
  it("canonicalizes every named field, keeping the empty sentinel", () => {
    expect(canonRecordInstants({ createdAt: "", updatedAt: "2026-03-01T10:00:00Z" }, ["createdAt", "updatedAt"]))
      .toEqual({ createdAt: "", updatedAt: "2026-03-01T10:00:00.000Z" });
  });

  it("rejects the whole record when any field breaks the contract", () => {
    expect(canonRecordInstants({ createdAt: "2026-03-01T10:00:00Z", updatedAt: "March 5" }, ["createdAt", "updatedAt"])).toBeNull();
  });
});
