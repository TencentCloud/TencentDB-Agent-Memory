/**
 * 统一 SSE 帧解析器测试：LF/CRLF、紧凑格式、多 data 行、注释、跨 chunk、[DONE]。
 */
import { describe, it, expect } from "vitest";
import { createSseFrameParser } from "../common/sse.js";

describe("createSseFrameParser", () => {
  it("标准 LF 帧：event + data", () => {
    const p = createSseFrameParser();
    const frames = p.push(
      'event: message_start\ndata: {"a":1}\n\n' +
        'event: content_block_delta\ndata: {"b":2}\n\n',
    );
    expect(frames).toEqual([
      { event: "message_start", data: '{"a":1}' },
      { event: "content_block_delta", data: '{"b":2}' },
    ]);
  });

  it("CRLF 帧分隔", () => {
    const p = createSseFrameParser();
    const frames = p.push('event: x\r\ndata: {"a":1}\r\n\r\n');
    expect(frames).toEqual([{ event: "x", data: '{"a":1}' }]);
  });

  it("紧凑格式 event:xxx / data:{...}（冒号后无空格）", () => {
    const p = createSseFrameParser();
    const frames = p.push('event:response.done\ndata:{"a":1}\n\n');
    expect(frames).toEqual([{ event: "response.done", data: '{"a":1}' }]);
  });

  it("单帧多 data 行按 \\n 拼接", () => {
    const p = createSseFrameParser();
    const frames = p.push('data: {"a":\ndata: 1}\n\n');
    expect(frames).toEqual([{ event: null, data: '{"a":\n1}' }]);
  });

  it("注释行（: 开头）与其它字段忽略", () => {
    const p = createSseFrameParser();
    const frames = p.push(': keep-alive\nevent: x\ndata: {"a":1}\nretry: 100\n\n');
    expect(frames).toEqual([{ event: "x", data: '{"a":1}' }]);
  });

  it("跨 chunk 的残缺帧缓冲，end() 收尾", () => {
    const p = createSseFrameParser();
    expect(p.push('event: x\ndata: {"a')).toEqual([]);
    const frames = p.push('":1}\n\n');
    expect(frames).toEqual([{ event: "x", data: '{"a":1}' }]);
    // 无结尾空行 → end() 收尾
    const p2 = createSseFrameParser();
    p2.push('event: y\ndata: {"b":2}');
    expect(p2.end()).toEqual([{ event: "y", data: '{"b":2}' }]);
  });

  it("[DONE] 作为普通 data 帧返回", () => {
    const p = createSseFrameParser();
    const frames = p.push("data: [DONE]\n\n");
    expect(frames).toEqual([{ event: null, data: "[DONE]" }]);
  });

  it("空输入 / 纯空行无帧", () => {
    const p = createSseFrameParser();
    expect(p.push("")).toEqual([]);
    expect(p.push("\n\n\n")).toEqual([]);
    expect(p.end()).toEqual([]);
  });
});
