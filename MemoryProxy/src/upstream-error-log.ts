import type { createPipeline } from "./logger.js";
import { log } from "./report/log.js";

const ERROR_BODY_PREVIEW_CHARS = 2000;
const ERROR_BODY_PREVIEW_BYTES = 8192;
const ERROR_BODY_READ_TIMEOUT_MS = 2000;

async function errorBodyPreview(response: Response): Promise<string> {
  const clone = response.clone();
  const reader = clone.body?.getReader();
  if (!reader) return "";

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    reader.cancel("upstream error preview timeout").catch(() => {});
  }, ERROR_BODY_READ_TIMEOUT_MS);

  try {
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    while (bytes < ERROR_BODY_PREVIEW_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (bytes >= ERROR_BODY_PREVIEW_BYTES) {
        await reader.cancel("upstream error preview limit").catch(() => {});
        break;
      }
    }
    text += decoder.decode();
    const suffix = timedOut ? " [preview timed out]" : bytes >= ERROR_BODY_PREVIEW_BYTES ? " [truncated]" : "";
    return `${text.slice(0, ERROR_BODY_PREVIEW_CHARS)}${suffix}`;
  } catch (err: unknown) {
    if (timedOut) return "[unable to read error body: preview timed out]";
    return `[unable to read error body: ${err instanceof Error ? err.message : String(err)}]`;
  } finally {
    clearTimeout(timer);
  }
}

/** Log an upstream HTTP error through a request pipeline, preserving correlation IDs. */
export async function logPipelineUpstreamError(
  pipe: ReturnType<typeof createPipeline>,
  response: Response,
  stage = "UPSTREAM_ERROR",
): Promise<void> {
  if (response.status < 400) return;
  const upstreamRequestId = response.headers.get("x-request-id") ?? "";
  const body = await errorBodyPreview(response);
  pipe.error(
    stage,
    `status=${response.status} upstreamRequestId=${upstreamRequestId || "-"} body=${body}`,
  );
}

/** Log an upstream HTTP error for passthrough paths that do not own a Pipeline. */
export async function logStandaloneUpstreamError(args: {
  response: Response;
  requestId: string;
  clientRequestId?: string;
  upstreamUrl: string;
  event?: string;
}): Promise<void> {
  if (args.response.status < 400) return;
  const upstreamRequestId = args.response.headers.get("x-request-id") ?? "";
  const body = await errorBodyPreview(args.response);
  log.error(args.event ?? "upstream.error", {
    requestId: args.requestId,
    clientRequestId: args.clientRequestId,
    upstreamRequestId,
    upstreamUrl: args.upstreamUrl,
    status: args.response.status,
    body,
  });
}
