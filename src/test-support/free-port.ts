/**
 * A loopback port nobody is listening on — for tests and probes.
 *
 * Not a product module: nothing under src/ imports it, only test files and the
 * probe harness do. It lives here because the alternative was every suite
 * picking `BASE + Math.random() * N` out of its own narrow range, and those
 * ranges collided — vitest runs the files in parallel, so a gateway would fail
 * to bind with EADDRINUSE in whichever suite lost the race, at random.
 *
 * The port is taken by binding one and letting it go: between the release and
 * the caller's own bind, the OS hands out other numbers first, which is as
 * close to "free" as a port can be promised.
 */
import http from "node:http";

export async function freePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
