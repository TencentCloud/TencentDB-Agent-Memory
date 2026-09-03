/**
 * Split an upstream response stream into an exact client branch and an
 * independently consumed observation branch.
 *
 * A TransformStream placed directly in the client branch never receives
 * `flush()` when a client cancels after seeing an SSE finish event.  L0 and
 * skill archival live in that flush path, so header-only clients such as
 * OpenClaw could receive a complete answer while silently losing writeback.
 * Keeping the tap on the second `tee()` branch lets it drain to EOF even when
 * the client branch is cancelled.
 */
export function forkStreamWithBackgroundTap<T>(
  source: ReadableStream<T>,
  tap: TransformStream<T, T>,
  onError: (error: unknown) => void,
): ReadableStream<T> {
  const [clientStream, tapSource] = source.tee();

  void tapSource
    .pipeThrough(tap)
    .pipeTo(new WritableStream<T>({
      // Deliberately discard the mirrored bytes. Side effects happen in tap.
      write() {},
    }))
    .catch(onError);

  return clientStream;
}
