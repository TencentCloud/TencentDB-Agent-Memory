/**
 * SSE 解析器模糊 / 抗造测试：
 *   - 随机、残缺、超大输入永不抛错；
 *   - 帧不丢失：任意切分位置与整喂结果一致（拼接无关性）；
 *   - 超大帧不被截断。
 *
 * 用确定性 PRNG 保证可复现（不是真随机，CI 可稳定重放）。
 */
import { describe, it, expect } from "vitest";
import { createSseFrameParser, type SseFrame } from "../common/sse.js";

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function collect(
  parser: ReturnType<typeof createSseFrameParser>,
  chunks: string[],
): SseFrame[] {
  const out: SseFrame[] = [];
  for (const c of chunks) out.push(...parser.push(c));
  out.push(...parser.end());
  return out;
}

/** 混合 LF / CRLF / 紧凑格式 / 多 data 行 / 注释 / 错误帧 / [DONE] 的参考流。 */
const REF_STREAM =
  'event: message_start\ndata: {"type":"message_start"}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}\r\n\r\n' +
  'event:content_block_delta\ndata:{"type":"x"}\n\n' +
  'data: {"a":\ndata: 1}\n\n' +
  ": comment\n" +
  'event: error\ndata: {"error":{"message":"boom"}}\n\n' +
  "data: [DONE]\n\n";

describe("SSE 解析器模糊测试（抗造）", () => {
  it("随机/残缺/控制字符输入永不抛错", () => {
    const rnd = mulberry32(20260830);
    const alphabet = '\n\r: evndta{}[],"\\0123456789abcdefghijklmnopqrstuvwxyz\x00';
    for (let i = 0; i < 3000; i++) {
      const p = createSseFrameParser();
      const len = Math.floor(rnd() * 2000);
      let s = "";
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      let pos = 0;
      let frames = 0;
      while (pos < s.length) {
        const step = 1 + Math.floor(rnd() * Math.max(1, s.length - pos));
        const chunk = s.slice(pos, pos + step);
        pos += step;
        const f = p.push(chunk);
        frames += f.length;
        expect(f.every((x) => x.event === null || typeof x.event === "string")).toBe(true);
      }
      frames += p.end().length;
      expect(typeof frames).toBe("number");
    }
  });

  it("切分无关性：任意切分位置与整喂结果一致（不吞帧）", () => {
    const whole = collect(createSseFrameParser(), [REF_STREAM]);
    expect(whole.length).toBeGreaterThan(3);
    for (let split = 1; split < REF_STREAM.length; split++) {
      const frames = collect(createSseFrameParser(), [
        REF_STREAM.slice(0, split),
        REF_STREAM.slice(split),
      ]);
      expect(frames).toEqual(whole);
    }
  });

  it("多块随机拼接与单块结果一致", () => {
    const rnd = mulberry32(7);
    const whole = collect(createSseFrameParser(), [REF_STREAM]);
    for (let i = 0; i < 100; i++) {
      const parts: string[] = [];
      let pos = 0;
      while (pos < REF_STREAM.length) {
        const step = 1 + Math.floor(rnd() * 40);
        parts.push(REF_STREAM.slice(pos, pos + step));
        pos += step;
      }
      expect(collect(createSseFrameParser(), parts)).toEqual(whole);
    }
  });

  it("超大帧不截断", () => {
    const big = "data: " + "x".repeat(1024 * 1024) + "\n\n";
    const frames = collect(createSseFrameParser(), [big]);
    expect(frames.length).toBe(1);
    expect(frames[0].data.length).toBe(1024 * 1024);
  });
});
