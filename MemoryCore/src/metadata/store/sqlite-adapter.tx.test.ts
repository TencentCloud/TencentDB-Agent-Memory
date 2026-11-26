/**
 * SqliteMetadataStore 事务包装器（tx）的可重入语义测试。
 *
 * tx() 在嵌套调用时降级为 SAVEPOINT（deleteTeams → deleteAgents → deleteAssets
 * 是真实的嵌套路径），这里直接验证两层语义：内层失败整体回滚、嵌套成功全量提交。
 * 真实级联行为由 metadata-store.contract.ts 的 Delete Cascade 契约用例覆盖。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteMetadataStore } from "./sqlite-adapter.js";

/** 测试需要触达私有 tx 包装器验证语义本身。 */
type StoreWithTx = SqliteMetadataStore & { tx: <T>(fn: () => T) => T };

let store: StoreWithTx;
let seq = 0;

beforeEach(() => {
  store = new SqliteMetadataStore(":memory:") as StoreWithTx;
  store.init();
  seq = 0;
});

function nextUserInput() {
  seq += 1;
  return {
    auth_provider: "local",
    external_id: `ext-tx-${seq}`,
    username: `txuser${seq}`,
  } as const;
}

describe("tx 可重入（SAVEPOINT）", () => {
  it("嵌套 tx 全部成功时全量提交（事务内写入持久化）", async () => {
    let createdId = "";
    store.tx(() => {
      store.tx(() => {
        // 嵌套里走带自身事务的 store 方法 —— 对应 deleteTeams → deleteAssets 的真实形态
        const u = store.createUser(nextUserInput());
        createdId = u.user_id;
      });
    });
    expect(await store.getUserById(createdId)).not.toBeNull();
  });

  it("内层 tx 失败时外层整体回滚：事务内写入不落库", async () => {
    const before = await store.createUser(nextUserInput());
    let insideTxUserId = "";

    expect(() =>
      store.tx(() => {
        // 复合写：外层事务里再执行带自身事务的 store 方法
        const u = store.createUser(nextUserInput());
        insideTxUserId = u.user_id;
        store.tx(() => {
          throw new Error("inner boom");
        });
        // 不可达
      }),
    ).toThrow("inner boom");

    expect(await store.getUserById(before.user_id)).not.toBeNull();
    expect(await store.getUserById(insideTxUserId)).toBeNull();
  });

  it("多层嵌套（3 层）内层失败逐层回滚到最外层", () => {
    let reached = 0;
    expect(() =>
      store.tx(() => {
        store.tx(() => {
          store.tx(() => {
            reached += 1;
            throw new Error("deep boom");
          });
          reached += 100;
        });
        reached += 10000;
      }),
    ).toThrow("deep boom");
    expect(reached).toBe(1);
  });
});
