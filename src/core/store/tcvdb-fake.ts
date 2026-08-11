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
  /** Filters the fake refused to evaluate. A contract test asserting a
   * non-empty read-back must also assert this stays empty: the store turns
   * every error into [], so a rejected filter is otherwise indistinguishable
   * from a collection that legitimately has nothing to return. */
  rejectedFilters: string[];
  /** Filter fields declared at collection creation, by collection — the
   * startup schema check reads them back through /collection/describe. */
  filterFields: Map<string, string[]>;
  close: () => Promise<void>;
}

/**
 * The filter grammar the store actually emits: `field < N`, `field in (…)`,
 * `field = "v"`, `field != "v"`, composed with `and` / `or` and parentheses —
 * the scope predicate is `scope = "global" or (scope = "project" and
 * project_id = "…")`.
 *
 * A missing field matches NOTHING, including `!=`. That mirrors the backend
 * rather than JS defaults: a document written before the field existed does not
 * quietly satisfy `scope != "project"`, and a fake that pretended otherwise
 * would confirm a parity the real store does not have.
 *
 * Anything outside the grammar throws — see `rejectedFilters`. Returning "no
 * matches" instead would be invisible: the store catches every error into an
 * empty array, so a broken filter and an empty collection look identical.
 */
class UnsupportedFilter extends Error {}

function compare(doc: Doc, expression: string): boolean {
  const binary = /^(\w+)\s*(<|!=|=)\s*(?:"([^"]*)"|'([^']*)'|(\d+))$/.exec(
    expression.trim(),
  );
  if (binary) {
    const [, field, op, dq, sq, num] = binary;
    if (!(field! in doc) || doc[field!] === undefined || doc[field!] === null)
      return false;
    const actual = doc[field!];
    if (op === "<") return Number(actual) < Number(num ?? 0);
    const expected = dq ?? sq ?? num ?? "";
    return op === "="
      ? String(actual) === expected
      : String(actual) !== expected;
  }
  const inList = /^(\w+)\s+in\s+\((.*)\)$/.exec(expression.trim());
  if (inList) {
    if (!(inList[1]! in doc)) return false;
    const values = inList[2]!
      .split(",")
      .map((v) => v.trim().replace(/^["']|["']$/g, ""));
    return values.includes(String(doc[inList[1]!]));
  }
  throw new UnsupportedFilter(expression);
}

/** or → and → parenthesised group → comparison. */
function evaluate(doc: Doc, expression: string): boolean {
  const trimmed = expression.trim();
  for (const [token, combine] of [
    ["or", (a: boolean, b: boolean) => a || b],
    ["and", (a: boolean, b: boolean) => a && b],
  ] as const) {
    const parts = splitTop(trimmed, token);
    if (parts.length > 1) {
      return parts.map((part) => evaluate(doc, part)).reduce(combine);
    }
  }
  if (trimmed.startsWith("(") && trimmed.endsWith(")"))
    return evaluate(doc, trimmed.slice(1, -1));
  return compare(doc, trimmed);
}

/** Split on a keyword that sits outside parentheses and outside quotes. */
function splitTop(expression: string, keyword: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let i = 0; i < expression.length; i += 1) {
    const char = expression[i]!;
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (depth === 0 && expression.startsWith(` ${keyword} `, i - 1)) {
      parts.push(expression.slice(start, i - 1));
      i += keyword.length;
      start = i + 1;
    }
  }
  parts.push(expression.slice(start));
  return parts;
}

export async function startTcvdbFake(): Promise<TcvdbFake> {
  const databases = new Set<string>();
  const collections = new Map<string, Map<string, Doc>>();
  const rejectedFilters: string[] = [];
  const filterFields = new Map<string, string[]>();

  /** Evaluate a filter, journalling anything outside the supported grammar. */
  const admits = (doc: Doc, filter: string | undefined): boolean => {
    if (!filter) return true;
    try {
      return evaluate(doc, filter);
    } catch (error) {
      if (error instanceof UnsupportedFilter) {
        rejectedFilters.push(filter);
        throw error;
      }
      throw error;
    }
  };

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

      try {
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
            return reply({
              collection: {
                collection,
                documentCount: collections.get(collection)?.size ?? 0,
                indexes: (filterFields.get(collection) ?? []).map(
                  (fieldName) => ({
                    fieldName,
                    fieldType: "string",
                    indexType: "filter",
                  }),
                ),
              },
            });
          }
          case "/collection/create": {
            collections.set(collection, new Map());
            const indexes = (body.indexes ?? []) as Array<
              Record<string, unknown>
            >;
            filterFields.set(
              collection,
              indexes
                .filter((index) => index.indexType === "filter")
                .map((index) => String(index.fieldName)),
            );
            return reply({});
          }
          case "/document/query": {
            const store = collections.get(collection) ?? new Map<string, Doc>();
            const query = (body.query ?? {}) as {
              filter?: string;
              documentIds?: string[];
              limit?: number;
            };
            const ids = new Set(query.documentIds ?? []);
            const documents = [...store.values()]
              .filter(
                (doc) =>
                  (ids.size === 0 || ids.has(String(doc.id))) &&
                  admits(doc, query.filter),
              )
              .slice(0, query.limit ?? 100);
            return reply({ documents });
          }
          case "/document/search":
          case "/document/hybridSearch": {
            const store = collections.get(collection) ?? new Map<string, Doc>();
            // The client nests both endpoints' parameters under `search`
            // (tcvdb-client.ts:241,250) — reading them off the body root would
            // silently drop every filter and pass the parity test for free.
            const search = (body.search ?? {}) as {
              filter?: string;
              limit?: number;
            };
            const filter =
              typeof search.filter === "string" ? search.filter : undefined;
            const limit = Number(search.limit ?? 10);
            // No ranking: the fake exists to prove filtering and field round-trip,
            // and a made-up score would only look like relevance.
            const documents = [...store.values()]
              .filter((doc) => admits(doc, filter))
              .slice(0, limit)
              .map((doc) => ({ ...doc, score: 1 }));
            return reply({ documents: [documents] });
          }
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
                if (admits(doc, query.filter)) {
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
              if (admits(doc, filter)) count += 1;
            return reply({ count });
          }
          default:
            res.writeHead(404, { "content-type": "application/json" });
            res.end(
              JSON.stringify({ code: 15000, msg: `no route ${req.url}` }),
            );
        }
      } catch (error) {
        if (error instanceof UnsupportedFilter) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              code: 15001,
              msg: `unsupported filter: ${error.message}`,
            }),
          );
          return;
        }
        throw error;
      }
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    collections,
    rejectedFilters,
    filterFields,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
