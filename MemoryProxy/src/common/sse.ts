/**
 * 状态化 SSE 帧解析器（协议转换层共用）。
 *
 * 统一处理 4 个转换器里重复出现的“缓冲 → 切帧 → 提 event/data”逻辑，并补上
 * 此前各实现遗漏的健壮性：
 *   - CRLF / LF 帧分隔（\r\n\r\n 与 \n\n）
 *   - `event: xxx` 与紧凑格式 `event:xxx`（冒号后无空格）
 *   - `data: xxx` 与紧凑格式 `data:xxx`
 *   - 单帧多 data 行（按 \n 拼接）
 *   - 注释行（`:` 开头）忽略
 *   - 跨 chunk 的残缺帧缓冲，flush/end 时收尾
 *   - `[DONE]` 作为普通 data 帧返回，由调用方判断
 *
 * 独立约束：纯函数式、无副作用，便于单测。
 */

export interface SseFrame {
  /** `event:` 行内容；缺省为 null（调用方回落到协议默认类型）。 */
  event: string | null;
  /** 该帧全部 `data:` 行按 \n 拼接后的内容（含 [DONE]）。 */
  data: string;
}

export interface SseFrameParser {
  push(chunk: string): SseFrame[];
  end(): SseFrame[];
}

function parseFrames(text: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const rawFrame of text.split(/\r?\n\r?\n/)) {
    if (rawFrame.trim() === "") continue;
    let event: string | null = null;
    const data: string[] = [];
    for (const line of rawFrame.split(/\r?\n/)) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).trimStart());
      }
      // 其它行（含 `:` 开头的注释、空行内嵌）忽略
    }
    if (data.length > 0) frames.push({ event, data: data.join("\n") });
  }
  return frames;
}

/** 创建带跨 chunk 缓冲的 SSE 帧解析器。 */
export function createSseFrameParser(): SseFrameParser {
  let buf = "";
  return {
    push(chunk: string): SseFrame[] {
      buf += chunk;
      const parts = buf.split(/\r?\n\r?\n/);
      buf = parts.pop() ?? "";
      const out: SseFrame[] = [];
      for (const p of parts) out.push(...parseFrames(p));
      return out;
    },
    end(): SseFrame[] {
      const tail = buf;
      buf = "";
      return tail.trim() === "" ? [] : parseFrames(tail);
    },
  };
}
