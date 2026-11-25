/**
 * Tests for #779 (step 1) — export manifest schema validation.
 */

import { describe, expect, it } from "vitest";
import {
  MANIFEST_SCHEMA_VERSION,
  validateManifest,
  type ExportManifest,
} from "../../scripts/export-memory/manifest.js";

const validManifest: ExportManifest = {
  schema_version: MANIFEST_SCHEMA_VERSION,
  created_at: "2026-08-05T00:00:00.000Z",
  source_instance_id: "inst-1",
  assets: [
    {
      type: "chat-memory",
      id: "default",
      files: [
        {
          path: "conversations/2026-08-01.jsonl",
          checksum: `sha256:${"a".repeat(64)}`,
          size: 10,
        },
      ],
    },
  ],
};

describe("validateManifest (#779)", () => {
  it("accepts a valid manifest", () => {
    expect(() => validateManifest(validManifest)).not.toThrow();
  });

  it("rejects an unknown schema_version", () => {
    expect(() => validateManifest({ ...validManifest, schema_version: "9.9.9" })).toThrow();
  });

  it("rejects a malformed checksum", () => {
    const bad = {
      ...validManifest,
      assets: [
        {
          ...validManifest.assets[0],
          files: [{ path: "a.jsonl", checksum: "md5:xyz", size: 1 }],
        },
      ],
    };
    expect(() => validateManifest(bad)).toThrow(/checksum/);
  });

  it("rejects an empty files list", () => {
    const bad = {
      ...validManifest,
      assets: [{ ...validManifest.assets[0], files: [] }],
    };
    expect(() => validateManifest(bad)).toThrow();
  });

  it("rejects an unsupported asset type", () => {
    const bad = {
      ...validManifest,
      assets: [{ ...validManifest.assets[0], type: "brain" }],
    };
    expect(() => validateManifest(bad)).toThrow();
  });
});
