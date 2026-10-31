import { describe, expect, it } from "vitest";

import { extractUserQueryText } from "../user-query-extractor.js";

/**
 * DSH 0.2.1 起，harness 会以 `role=user` 追加两类运行时通知：
 *   - time-context：每个 step 一条三行读数
 *   - working-directory：工作目录切换 / 失效提示
 * 它们必须被判为"非用户输入"，否则 extractLatestUserMessage 会从后往前扫到
 * 它，把 harness 元数据当成用户提问写进 L0。
 *
 * 文案取自 dsh 源码与线上 L0 实际落库内容（逐字一致）：
 *   packages/context/time-context/src/index.ts::renderText
 *   packages/context/time-context/src/request-zone.ts::renderBrowserTimeZoneContext
 *   packages/session/working-directory/src/index.ts::commit
 */
const TIME_CONTEXT_READING = [
  "Time sampled while preparing turn 6, step 1: 2026-10-18T16:44:01+08:00[Asia/Shanghai]",
  "Browser time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.",
  "Elapsed since the preceding model-visible message: 1m 12s.",
].join("\n");

const CWD_CHANGED =
  'The working directory changed from "D:\\AI Project\\code" to "D:\\AI Project\\deepseek-harness\\Code".';

const CWD_UNAVAILABLE =
  'The working directory "D:\\gone" is unavailable. The working directory is now "D:\\new".';

describe("DSH runtime notices: standalone user message", () => {
  it("drops the time-context reading (all three lines)", () => {
    expect(extractUserQueryText(TIME_CONTEXT_READING)).toBe("");
  });

  it("drops the step-context variant of the elapsed line", () => {
    const raw = TIME_CONTEXT_READING.replace(
      "Elapsed since the preceding model-visible message",
      "Elapsed since the preceding step context",
    );
    expect(extractUserQueryText(raw)).toBe("");
  });

  it("drops the working-directory change notice", () => {
    expect(extractUserQueryText(CWD_CHANGED)).toBe("");
  });

  it("drops the working-directory unavailable notice", () => {
    expect(extractUserQueryText(CWD_UNAVAILABLE)).toBe("");
  });

  it("still drops the legacy runtime-context snapshot", () => {
    expect(extractUserQueryText("Current runtime context.\n- platform: win32")).toBe("");
  });
});

/**
 * Anthropic（deepseek-official）通道会把连续同 role 的 content block 合并进
 * 同一条 user 消息（llm adapter 的 serialize 步骤），此时通知不再是独立消息。
 * 若按"整条丢弃"判定，真问题会被一起吞掉 —— 所以判定必须落在行级。
 */
describe("DSH runtime notices: merged into one user message", () => {
  it("keeps the real question and strips the trailing reading", () => {
    const raw = [
      "帮我看一下 L0 里为什么多出来的这两句",
      TIME_CONTEXT_READING,
    ].join("\n");

    expect(extractUserQueryText(raw)).toBe("帮我看一下 L0 里为什么多出来的这两句");
  });

  it("keeps the real question when the reading comes first", () => {
    const raw = [
      TIME_CONTEXT_READING,
      "为什么 dsh 的目录提示也进 L0 了？",
    ].join("\n");

    expect(extractUserQueryText(raw)).toBe("为什么 dsh 的目录提示也进 L0 了？");
  });

  it("strips a merged working-directory notice as well", () => {
    const raw = ["继续刚才的重构", CWD_CHANGED].join("\n");

    expect(extractUserQueryText(raw)).toBe("继续刚才的重构");
  });

  it("keeps the question when both notice kinds are merged in", () => {
    const raw = [TIME_CONTEXT_READING, CWD_CHANGED, "开工吧"].join("\n");

    expect(extractUserQueryText(raw)).toBe("开工吧");
  });
});

describe("real user input is preserved", () => {
  it("keeps a plain question", () => {
    expect(extractUserQueryText("帮我看一下 L0 里为什么多出来的这两句")).toBe(
      "帮我看一下 L0 里为什么多出来的这两句",
    );
  });

  it("keeps a question that merely quotes the notice wording mid-line", () => {
    const raw = 'I saw "Time sampled while preparing turn 1, step 1:" in L0, why?';
    expect(extractUserQueryText(raw)).toBe(raw);
  });

  it("keeps a user sentence that mentions the working directory mid-line", () => {
    const raw = "why did the working directory change from code to harness?";
    expect(extractUserQueryText(raw)).toBe(raw);
  });
});

/**
 * DSH 后台任务（jobs 插件）的结算通知。文案取自
 * packages/jobs/tool-jobs/src/index.ts::fitCompletionNotice，落库形态取自
 * 线上 L0 里实际出现的行（pwsh-91 / pwsh-10）。
 *
 * 与 time-context 的关键差别：label 是命令原文、自带换行 —— 整条通知本身就是
 * 多行文本，所以按行剥只会剥掉首行、把命令片段留在库里。
 */
const JOB_NOTICE_MULTILINE = [
  'background job pwsh-91 (pwsh: $dst = "D:\\tmp\\dsh.zip"',
  'Expand-Archive -Path $dst -DestinationPath "D:\\tmp\\dsh" -Force) finished [status: completed, exit code: 0]. Read its output with job_output.',
].join("\n");

describe("DSH job completion notices", () => {
  it("drops a standalone notice whose label spans lines", () => {
    expect(extractUserQueryText(JOB_NOTICE_MULTILINE)).toBe("");
  });

  it("drops the truncated form ([notice truncated] + Done; job_output.)", () => {
    const raw = ["background job pwsh-92 (pwsh: some very long command", "[notice truncated]", "Done; job_output."].join(
      "\n",
    );
    expect(extractUserQueryText(raw)).toBe("");
  });

  it("drops the compact form (id on its own line + Done; job_output.)", () => {
    expect(extractUserQueryText("background job pwsh-93\nDone; job_output.")).toBe("");
  });

  it("drops the id-less recovery form", () => {
    expect(extractUserQueryText("background job ended; use job_list for id.")).toBe("");
  });

  it("keeps the real question when the notice is merged after it", () => {
    const raw = ["L0 里这两条 pwsh 记录怎么清？", JOB_NOTICE_MULTILINE].join("\n");

    expect(extractUserQueryText(raw)).toBe("L0 里这两条 pwsh 记录怎么清？");
  });

  it("keeps the real question when the notice is merged before it", () => {
    const raw = [JOB_NOTICE_MULTILINE, "继续刚才的事"].join("\n");

    expect(extractUserQueryText(raw)).toBe("继续刚才的事");
  });

  it("keeps a user sentence that mentions background jobs but has no notice tail", () => {
    const raw = "background job 这些记录是不是该从 L0 删掉？";

    expect(extractUserQueryText(raw)).toBe(raw);
  });
});
