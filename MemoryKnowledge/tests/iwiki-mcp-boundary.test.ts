import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type RequestListener, type Server } from "node:http";
import { getDocument, getSpaceRoot, IWikiMcpError } from "../src/wiki-source/providers/iwiki/mcp-client.js";

const marker = "synthetic-private-provider-detail";
const token = "synthetic-bearer";
const docid = "synthetic-private-doc";
const servers: Server[] = [];

async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return "http://127.0.0.1:" + (server.address() as { port: number }).port;
}

function context(endpoint: string): Parameters<typeof getDocument>[0] {
  return { endpoint, secret: token, timeoutMs: 2000 };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("iWiki HTTP and error boundary", () => {
  it("retains successful document text and bearer/body forwarding", async () => {
    let observed = false;
    const url = await serve((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        expect(request.headers.authorization).toBe("Bearer " + token);
        expect(JSON.parse(body).params.arguments.docid).toBe(docid);
        observed = true;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ result: { content: [{ type: "text", text: marker }] } }));
      });
    });
    expect(await getDocument(context(url), docid)).toEqual({ markdown: marker });
    expect(observed).toBe(true);
  });

  it("retains authentication status without provider response text", async () => {
    const url = await serve((_request, response) => {
      response.writeHead(401);
      response.end(marker);
    });
    const error = await getDocument(context(url), docid).catch((error) => error);
    expect(error).toBeInstanceOf(IWikiMcpError);
    expect(error.status).toBe(401);
    expect(error.message).not.toContain(marker);
  });

  const failures = [
    ["JSON-RPC", { error: { message: marker } }],
    ["tool", { result: { isError: true, content: [{ type: "text", text: marker }] } }],
    ["application", { result: { content: [{ type: "text", text: JSON.stringify({ msg: "error", message: marker }) }] } }],
  ] as const;
  for (const [name, envelope] of failures) {
    it("does not reflect " + name + " error detail", async () => {
      const url = await serve((_request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(envelope));
      });
      const result = name === "application"
        ? getSpaceRoot(context(url), "synthetic-space")
        : getDocument(context(url), docid);
      const error = await result.catch((error) => error);
      expect(error).toBeInstanceOf(IWikiMcpError);
      expect(error.message).not.toContain(marker);
    });
  }

  it("does not reflect injected transport exception detail", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error(marker));
    const error = await getDocument(context("http://127.0.0.1"), docid).catch((error) => error);
    expect(error).toBeInstanceOf(IWikiMcpError);
    expect(error.message).not.toContain(marker);
  });

  for (const status of [301, 302, 303, 307, 308]) {
    for (const sameOrigin of [true, false]) {
      it(`rejects ${status} ${sameOrigin ? "same" : "cross"} origin before forwarding RPC`, async () => {
        let redirected = 0;
        const destination: RequestListener = (_request, response) => {
          redirected++;
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ result: { content: [{ type: "text", text: "unexpected" }] } }));
        };
        const target = await serve(destination);
        let base = "";
        base = await serve((request, response) => {
          if (request.url === "/redirected") {
            destination(request, response);
          } else {
            response.writeHead(status, { location: sameOrigin ? base + "/redirected" : target });
            response.end();
          }
        });
        const error = await getDocument(context(base), docid).catch((error) => error);
        expect(redirected).toBe(0);
        expect(error).toBeInstanceOf(IWikiMcpError);
      });
    }
  }
});
