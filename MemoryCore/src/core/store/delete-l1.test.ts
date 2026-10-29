import { describe, expect, it, vi } from "vitest";
import { deleteL1RecordsStrict } from "./delete-l1.js";
import type { IMemoryStore } from "./types.js";

describe("deleteL1RecordsStrict", () => {
  it("keeps misses as non-errors and requests strict store semantics", async () => {
    const deleteL1 = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const store = { deleteL1 } as unknown as IMemoryStore;

    await expect(deleteL1RecordsStrict(
      store,
      ["missing", "deleted"],
      { teamId: "team" },
    )).resolves.toEqual({ deletedIds: ["deleted"] });

    expect(deleteL1).toHaveBeenNthCalledWith(
      1,
      "missing",
      { teamId: "team" },
      { throwOnError: true },
    );
    expect(deleteL1).toHaveBeenNthCalledWith(
      2,
      "deleted",
      { teamId: "team" },
      { throwOnError: true },
    );
  });

  it("returns successful ids plus the store error when a later delete fails", async () => {
    const failure = new Error("database offline");
    const deleteL1 = vi.fn()
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(failure);
    const store = { deleteL1 } as unknown as IMemoryStore;

    await expect(deleteL1RecordsStrict(store, ["first", "second"]))
      .resolves.toEqual({ deletedIds: ["first"], error: failure });
  });
});
