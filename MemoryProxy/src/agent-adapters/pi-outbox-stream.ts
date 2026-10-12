/** Forward content as it arrives, but release the completion marker only after local commit. */
export function createPiDurableStreamTap(observe: (text: string) => void, commit: () => Promise<void>) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = "";
  let terminal = "";
  function consume(controller: TransformStreamDefaultController<Uint8Array>) {
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(buffered))) {
      const frame = buffered.slice(0, match.index + match[0].length);
      buffered = buffered.slice(frame.length);
      observe(frame.replace(/\r\n/g, "\n"));
      if (terminal || /^data:\s*\[DONE\]\s*$/m.test(frame)) terminal += frame;
      else controller.enqueue(encoder.encode(frame));
    }
  }
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) { buffered += decoder.decode(chunk, { stream: true }); consume(controller); },
    async flush(controller) {
      buffered += decoder.decode();
      consume(controller);
      // An interrupted/incomplete model stream is not a completed recording operation.
      if (!terminal || buffered.trim()) throw new Error("Pi stream ended without a complete terminal event");
      await commit();
      controller.enqueue(encoder.encode(terminal + buffered));
    },
  });
}
