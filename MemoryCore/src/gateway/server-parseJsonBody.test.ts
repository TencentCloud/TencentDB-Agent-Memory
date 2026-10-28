/**
 * parseJsonBody must settle even when the underlying request dies while a
 * zlib (gzip/deflate) stream is in the pipe chain — errors and aborts on
 * `req` are not forwarded through .pipe(), so without explicit handling
 * the promise hangs and the handler never responds.
 */
import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import zlib from "node:zlib";
import type http from "node:http";
import { parseJsonBody } from "./server.js";

function fakeReq(encoding?: string): http.IncomingMessage & PassThrough {
  const pt = new PassThrough();
  const req = pt as unknown as http.IncomingMessage & PassThrough;
  req.headers = encoding ? { "content-encoding": encoding } : {};
  return req;
}

describe("parseJsonBody with compressed bodies", () => {
  it("parses a well-formed gzip body", async () => {
    const req = fakeReq("gzip");
    const p = parseJsonBody(req);
    req.end(zlib.gzipSync('{"a":1}'));
    await expect(p).resolves.toEqual({ a: 1 });
  });

  it("rejects when req emits an error mid-decompression", async () => {
    const req = fakeReq("gzip");
    const p = parseJsonBody(req);
    req.write(zlib.gzipSync('{"a":1}').subarray(0, 5));
    req.emit("error", new Error("socket boom"));
    await expect(p).rejects.toThrow("socket boom");
  });

  it("rejects 'Request aborted' when req aborts mid-body", async () => {
    const req = fakeReq("gzip");
    const p = parseJsonBody(req);
    req.write(zlib.gzipSync('{"a":1}').subarray(0, 5));
    req.emit("aborted");
    await expect(p).rejects.toThrow("Request aborted");
  });

  it("rejects 'Request aborted' when req closes before ending", async () => {
    const req = fakeReq("deflate");
    const p = parseJsonBody(req);
    req.write(zlib.deflateSync('{"a":1}').subarray(0, 3));
    // premature close: stream never ended
    req.emit("close");
    await expect(p).rejects.toThrow("Request aborted");
  });

  it("settles exactly once when both 'end' and 'close' fire", async () => {
    const req = fakeReq("gzip");
    const p = parseJsonBody(req);
    req.end(zlib.gzipSync('{"ok":true}'));
    // give the pipeline a tick to flush 'end' through gunzip
    await expect(p).resolves.toEqual({ ok: true });
    // a late 'close' after completion must not reject/destroy anything
    req.emit("close");
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("uncompressed path still parses normally", async () => {
    const req = fakeReq();
    const p = parseJsonBody(req);
    req.end('{"plain":2}');
    await expect(p).resolves.toEqual({ plain: 2 });
  });
});
