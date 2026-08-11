/**
 * An in-process fake of the TCVDB HTTP API — enough of it to run the REAL
 * `TcvdbMemoryStore` (tz-03b, contract test).
 *
 * A hand-written stub implementing `IMemoryStore` would prove nothing about
 * `tcvdb.ts`; this makes the actual backend talk to the actual client
 * (`undici.request`) over a real socket, so its filters, collection naming and
 * degradation behaviour are the ones under test.
 *
 * Seven endpoints, one `switch`, documents in a `Map`. Not a TCVDB emulator:
 * the filter grammar is supported only for the two shapes the store emits.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

type Doc = Record<string, unknown>;

export interface TcvdbFake {
  url: string;
  /** Documents by collection — the test's window into the "database". */
  collections: Map<string, Map<string, Doc>>;
  close: () => Promise<void>;
}

/** `updated_time_ms < 123` and `record_id in ("a","b")` — the only two the store emits. */
function matches(doc: Doc, filter: string | undefined): boolean {
  if (!filter) return true;
  const less = /^(\w+)\s*<\s*(\d+)$/.exec(filter);
  if (less) return Number(doc[less[1]!] ?? 0) < Number(less[2]);
  const inList = /^(\w+)\s+in\s+\((.*)\)$/.exec(filter);
  if (inList) {
    const values = inList[2]!
      .split(",")
      .map((v) => v.trim().replace(/^["']|["']$/g, ""));
    return values.includes(String(doc[inList[1]!] ?? ""));
  }
  return false; // an unknown filter matches nothing — visible, not silent
}

export async function startTcvdbFake(): Promise<TcvdbFake> {
  const databases = new Set<string>();
  const collections = new Map<string, Map<string, Doc>>();

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
      const collection = String(body.collection ?? "");
      const reply = (payload: Record<string, unknown>): void => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: 0, msg: "ok", ...payload }));
      };

      switch (req.url) {
        case "/database/list":
          return reply({ databases: [...databases] });
        case "/database/create":
          databases.add(String(body.database ?? ""));
          return reply({});
        case "/collection/describe": {
          if (!collections.has(collection)) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(
              JSON.stringify({ code: 15302, msg: "collection not exist" }),
            );
            return;
          }
          return reply({ collection: { collection, documentCount: 0 } });
        }
        case "/collection/create":
          collections.set(collection, new Map());
          return reply({});
        case "/document/upsert": {
          const docs = (body.documents ?? []) as Doc[];
          const store = collections.get(collection) ?? new Map<string, Doc>();
          for (const d of docs) store.set(String(d.id), d);
          collections.set(collection, store);
          return reply({ affectedCount: docs.length });
        }
        case "/document/delete": {
          const store = collections.get(collection) ?? new Map<string, Doc>();
          const query = (body.query ?? {}) as {
            documentIds?: string[];
            filter?: string;
          };
          let removed = 0;
          for (const id of query.documentIds ?? []) {
            if (store.delete(id)) removed += 1;
          }
          if (query.filter !== undefined) {
            for (const [id, doc] of [...store]) {
              if (matches(doc, query.filter)) {
                store.delete(id);
                removed += 1;
              }
            }
          }
          return reply({ affectedCount: removed });
        }
        case "/document/count": {
          const store = collections.get(collection) ?? new Map<string, Doc>();
          const filter = (body.query as { filter?: string } | undefined)
            ?.filter;
          let count = 0;
          for (const doc of store.values())
            if (matches(doc, filter)) count += 1;
          return reply({ count });
        }
        default:
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ code: 15000, msg: `no route ${req.url}` }));
      }
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    collections,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
