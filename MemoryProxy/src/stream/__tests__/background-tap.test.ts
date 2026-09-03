import { describe, expect, it, vi } from "vitest";
import { forkStreamWithBackgroundTap } from "../background-tap.js";

describe("forkStreamWithBackgroundTap", () => {
  it("flushes the background tap after the client cancels early", async () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const observed: string[] = [];
    let resolveFlushed!: () => void;
    const flushed = new Promise<void>((resolve) => { resolveFlushed = resolve; });
    const onError = vi.fn();

    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: first\n\n"));
        setTimeout(() => {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }, 5);
      },
    });
    const tap = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        observed.push(decoder.decode(chunk));
        controller.enqueue(chunk);
      },
      flush() {
        resolveFlushed();
      },
    });

    const client = forkStreamWithBackgroundTap(source, tap, onError);
    const reader = client.getReader();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain("data: first");
    await reader.cancel("OpenClaw stops after finish_reason");

    await Promise.race([
      flushed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("tap did not flush")), 500)),
    ]);

    expect(observed.join("")).toContain("data: [DONE]");
    expect(onError).not.toHaveBeenCalled();
  });
});
