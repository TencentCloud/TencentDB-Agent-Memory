import { describe, expect, it, vi } from "vitest";
import type { MongoClient } from "mongodb";
import { MongoMetadataStore } from "./mongodb-adapter.js";

describe("MongoMetadataStore index initialization", () => {
  it("does not log duplicate key values from E11000 index failures", async () => {
    const secret = "sk-mem-super-secret-value";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = {
      db() {
        return {
          collection(name: string) {
            return {
              async createIndex(spec: Record<string, number>) {
                if (name === "meta_user_keys" && spec.key_value === 1) {
                  throw {
                    code: 11000,
                    errmsg: `E11000 duplicate key error collection: test.meta_user_keys index: key_value_1 dup key: { key_value: "${secret}" }`,
                  };
                }
              },
              find() {
                return { toArray: async () => [] };
              },
            };
          },
        };
      },
    } as unknown as MongoClient;

    await new MongoMetadataStore(client, "test", {
      ownsClient: false,
      useTransactions: true,
    }).init();

    const output = warn.mock.calls.flat().join(" ");
    expect(output).not.toContain(secret);
    expect(output).toContain("meta_user_keys");
    expect(output).toContain("key_value");
    expect(output).toContain("code=11000");
    expect(output).toMatch(/duplicate|unique/i);
  });
});
