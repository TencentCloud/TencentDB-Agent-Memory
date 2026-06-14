import { describe, expect, it } from "vitest";

import { parseMmdMeta } from "./mmd-meta.js";

describe("parseMmdMeta", () => {
  it("reads render-safe Mermaid comment metadata", () => {
    const content = [
      '%% mmd-meta: {"taskGoal":"生成日报","createdTime":"2026-06-02T07:02:05+08:00","updatedTime":"2026-06-14T18:39:06+08:00"}',
      "flowchart TD",
      '001-N1["daily-tech-news-digest<br/>status: doing<br/>summary: 已输出7期<br/>Timestamp: 2026-06-14T18:39:06+08:00"]',
    ].join("\n");

    const meta = parseMmdMeta("001-daily.mmd", "/tmp/001-daily.mmd", content);

    expect(meta.taskGoal).toBe("生成日报");
    expect(meta.createdTime).toBe("2026-06-02T07:02:05+08:00");
    expect(meta.updatedTime).toBe("2026-06-14T18:39:06+08:00");
    expect(meta.doingCount).toBe(1);
  });

  it("keeps reading legacy directive metadata", () => {
    const content = [
      '%%{ "taskGoal": "旧任务", "createdTime": "2026-06-02T07:02:05+08:00", "updatedTime": "2026-06-14T18:39:06+08:00" }%%',
      "flowchart TD",
    ].join("\n");

    const meta = parseMmdMeta("001-legacy.mmd", "/tmp/001-legacy.mmd", content);

    expect(meta.taskGoal).toBe("旧任务");
    expect(meta.createdTime).toBe("2026-06-02T07:02:05+08:00");
    expect(meta.updatedTime).toBe("2026-06-14T18:39:06+08:00");
  });
});
