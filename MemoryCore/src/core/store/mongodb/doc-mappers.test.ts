/**
 * mongodb 文档映射的纯函数测试（N07）。
 *
 * 为什么单独为一个 mapper 写测试：沙箱里起不了 mongo，这个后端绝大部分
 * 代码无法运行验证。但 doc-mappers 是**纯函数**——它恰好是整条链路上
 * 唯一一处"不需要真实服务也能证明对错"的地方，而它又正好是出过事的地方：
 *
 * docToL1RecordRow 曾经没有映射 review_status。后果不是"少一个字段"，
 * 而是**写入层的防复活守卫在 mongodb 上永远不触发**（守卫判的就是这个字段），
 * 以及审核清单把已撤回的记忆一律显示成 active。两者都不会报错，
 * 测试全绿，生产静默失效——正是最难发现的一类缺陷。
 */
import { describe, expect, it } from "vitest";
import { docToL1RecordRow, type L1Doc } from "./doc-mappers.js";
import { normalizeReviewStatus } from "../visibility.js";

function doc(over: Partial<L1Doc> & Record<string, unknown> = {}): L1Doc {
  return { _id: "m1", content: "c", type: "work_fact", ...over } as L1Doc;
}

describe("docToL1RecordRow — review_status 必须透传", () => {
  it("已撤回的文档映射出来仍然是 quarantined（守卫就靠这个字段）", () => {
    const row = docToL1RecordRow(doc({ review_status: "quarantined" } as never));
    expect(row.review_status).toBe("quarantined");
    expect(normalizeReviewStatus(row.review_status)).toBe("quarantined");
  });

  it("升级前的老文档没有该字段 ⇒ 归一成 active，而不是被当成已撤回", () => {
    const row = docToL1RecordRow(doc());
    expect(row.review_status).toBeUndefined();
    // 关键：缺字段不能被读成 quarantined，否则一次升级让全部历史记忆消失
    expect(normalizeReviewStatus(row.review_status)).toBe("active");
  });

  it("active 文档原样透传", () => {
    const row = docToL1RecordRow(doc({ review_status: "active" } as never));
    expect(normalizeReviewStatus(row.review_status)).toBe("active");
  });
});
