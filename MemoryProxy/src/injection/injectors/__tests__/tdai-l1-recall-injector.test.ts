import { describe, expect, it } from "vitest";

import type { ContextMessage } from "../../types.js";
import { lastHumanUserQuery } from "../tdai-l1-recall-injector.js";

function msg(role: ContextMessage["role"], text: string): ContextMessage {
  return { role, blocks: [{ type: "text", content: text }] };
}

const TIME_CONTEXT_READING = [
  "Time sampled while preparing turn 6, step 1: 2026-10-18T16:44:01+08:00[Asia/Shanghai]",
  "Browser time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.",
  "Elapsed since the preceding model-visible message: 1m 12s.",
].join("\n");

/** jobs 插件的结算通知：label 是命令原文，自带换行 */
const JOB_NOTICE = [
  'background job pwsh-91 (pwsh: $dst = "D:\\tmp\\dsh.zip"',
  'Expand-Archive -Path $dst -DestinationPath "D:\\tmp\\dsh" -Force) finished [status: completed, exit code: 0]. Read its output with job_output.',
].join("\n");

/**
 * L1 召回的检索词必须落在「最后一条含人类文本的 user 消息」上。
 * dsh 0.2.1 起每步都会追加一条 role=user 的通知；若照旧只取最后一条
 * user 消息，抽取结果是空串 → 整轮零召回。
 */
describe("lastHumanUserQuery", () => {
  it("skips a trailing harness notice and returns the real question", () => {
    const messages: ContextMessage[] = [
      msg("user", "上一轮的提问"),
      msg("assistant", "上一轮的回答"),
      msg("user", "这一轮的提问"),
      msg("user", TIME_CONTEXT_READING),
    ];

    expect(lastHumanUserQuery(messages)).toBe("这一轮的提问");
  });

  it("strips the notice when it is merged into the question message", () => {
    const messages: ContextMessage[] = [
      msg("user", ["这一轮的提问", TIME_CONTEXT_READING].join("\n")),
    ];

    expect(lastHumanUserQuery(messages)).toBe("这一轮的提问");
  });

  it("returns an empty string when no message carries human text", () => {
    const messages: ContextMessage[] = [
      msg("user", TIME_CONTEXT_READING),
      msg("assistant", "收到"),
    ];

    expect(lastHumanUserQuery(messages)).toBe("");
  });

  it("ignores non-user roles entirely", () => {
    const messages: ContextMessage[] = [
      msg("user", "真问题"),
      msg("assistant", "回答"),
      msg("tool", '{"answers":[{"id":"where","selected":[],"custom":"随便"}]}'),
    ];

    expect(lastHumanUserQuery(messages)).toBe("真问题");
  });

  it("skips a trailing job completion notice too", () => {
    const messages: ContextMessage[] = [
      msg("user", "这一轮的提问"),
      msg("assistant", "回答"),
      msg("user", JOB_NOTICE),
    ];

    expect(lastHumanUserQuery(messages)).toBe("这一轮的提问");
  });
});
