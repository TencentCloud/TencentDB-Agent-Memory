# FTS Query Safety Design

## Background

The memory plugin supports keyword recall through two store implementations:

- SQLite: local FTS5 tables queried with `MATCH ?`.
- TCVDB: remote hybrid search using raw natural-language `queryText` for dense embedding and BM25 sparse matching.

Historically, callers built an SQLite FTS5 expression with `buildFtsQuery()` and passed that string into `searchL1Fts()` / `searchL0Fts()`. This leaked SQLite-specific query syntax outside the SQLite store. It also created an unsafe abstraction: the same parameter was a valid SQLite `MATCH` expression for `sqlite.ts`, but natural language for `tcvdb.ts`.

The fix should protect SQLite FTS5 from operator injection while preserving natural-language recall quality for TCVDB.

## Options

### Option 1: Query Whitelist

Whitelist-based sanitization removes or escapes characters and keywords known to have FTS5 syntax meaning, such as:

- `"`
- `'`
- `(`
- `)`
- `*`
- `^`
- `AND` / `OR` / `NOT` / `NEAR`, case-insensitive
- field filters such as `title:apple`
- exclusion syntax such as `apple -banana`
- punctuation and symbols that can affect `MATCH` parsing

Advantages:

- Small patch surface.
- Easy to understand.
- Useful as defense in depth before tokenization.

Limitations:

- It is a string-filtering strategy, so it depends on continuously knowing which syntax is dangerous.
- It can accidentally remove legitimate user text if the rule is too broad.
- It does not fix the abstraction leak where non-SQLite stores receive SQLite query syntax.
- It is harder to prove correct as FTS syntax or tokenizer behavior changes.

### Option 2: Parameterized Query Boundary

Parameterized querying keeps user text as data until the store implementation reaches its own query boundary.

In this codebase, that means:

- Callers pass raw natural-language query strings to `IMemoryStore.searchL1Fts()` and `searchL0Fts()`.
- SQLite owns FTS5 expression construction internally.
- SQLite binds the generated FTS5 expression through prepared statements: `WHERE l1_fts MATCH ?` and `WHERE l0_fts MATCH ?`.
- TCVDB receives the unchanged raw query text for BM25 and embedding.
- Sanitization still exists inside SQLite, but it is defense in depth rather than the primary contract.

Advantages:

- Store-specific syntax no longer leaks into hooks, tools, or dedup logic.
- TCVDB no longer risks receiving `"term" OR "term2"` as BM25 input.
- The SQL statement remains parameterized; user input is never concatenated into SQL text.
- The caller contract is simpler: pass raw query text, receive ranked results.
- It is easier to test because SQLite-specific behavior is isolated in `sqlite.ts`.

Limitations:

- SQLite FTS5 accepts a single `MATCH` expression parameter, so individual terms cannot be bound as separate SQL placeholders.
- SQLite still needs to generate a valid FTS5 expression internally. The important boundary is that this expression is generated from tokenized terms and then bound as data to the prepared statement.

## Recommendation

Use the parameterized query boundary.

Whitelist sanitization alone is not enough because the main bug is architectural: callers were required to understand SQLite FTS5 query syntax even when the active store could be TCVDB. The safer design is to make raw query text the cross-store API and keep FTS5 syntax generation private to the SQLite implementation.

Sanitization should remain inside SQLite as defense in depth:

- Remove FTS5 operators before tokenization, including lowercase user input.
- Treat non-token punctuation and symbols as separators before tokenization.
- Tokenize with jieba when available.
- Drop punctuation-only tokens and stop words.
- Quote each token as an FTS5 phrase term.
- Bind the final expression to `MATCH ?`.

## Implemented Design

### Store Interface

`IMemoryStore` now treats FTS search input as raw text:

```ts
searchL1Fts(query: string, limit?: number): MaybePromise<L1FtsResult[]>;
searchL0Fts(query: string, limit?: number): MaybePromise<L0FtsResult[]>;
```

The interface no longer exposes the SQLite-specific `ftsQuery` concept.

### SQLite Store

`sqlite.ts` keeps `buildFtsQuery()` local to the SQLite implementation path:

1. `searchL1Fts(query, limit)` receives raw user text.
2. It calls `buildFtsQuery(query)`.
3. If tokenization produces no usable tokens, it returns an empty result.
4. It executes the existing prepared statement with bound parameters:

```sql
WHERE l1_fts MATCH ?
LIMIT ?
```

The same flow applies to `searchL0Fts()`.

`buildFtsQuery()` sanitizes before tokenization:

- removes standalone FTS5 operators case-insensitively: `AND`, `OR`, `NOT`, `NEAR`
- treats non-token punctuation and symbols as separators, including `:`, `-`, `\`, commas, CJK punctuation, and emoji
- preserves operator substrings inside ordinary words such as `ordinary` and `northeast`

### TCVDB Store

`tcvdb.ts` receives the same raw `query` parameter and passes it directly to hybrid search:

```ts
this.searchL1HybridAsync({ queryText: query, topK: limit });
this.searchL0HybridAsync({ queryText: query, topK: limit });
```

This preserves TCVDB recall quality because BM25 and embedding both see natural-language input instead of an SQLite FTS5 expression.

### Callers

The following layers now pass raw query text directly to the store:

- `auto-recall.ts`
- `memory-search.ts`
- `conversation-search.ts`
- `l1-dedup.ts`

These files no longer import `buildFtsQuery()` and no longer log or manipulate SQLite FTS5 expressions.

## Test Plan

Unit tests cover:

- basic syntax character removal
- all supported FTS5 operators
- embedded operator substrings that must not be removed
- lowercase FTS5 operators such as `and`, `or`, `not`, and `near`
- field filters, exclusion syntax, backslashes, commas, CJK punctuation, emoji, and repeated quotes
- empty result when input contains only FTS syntax
- jieba path sanitization before tokenization
- recall-relevant token equivalence after sanitization
- real SQLite `MATCH ?` execution for L1 and L0 FTS search
- write-side `tokenizeForFts()` and query-side `buildFtsQuery()` compatibility
- FTS index rebuild from metadata tables
- FTS v1 to v2 migration and rebuild

Very long input and repeated-token performance optimization are intentionally out of scope for this security fix.

Validation commands:

```bash
npm.cmd test -- src/core/store/sqlite.test.ts
npm.cmd test
npm.cmd run build
```

## Rollout Notes

This change is source-compatible for in-repo callers because they now pass raw query text. It is behaviorally safer for both stores:

- SQLite keeps the same BM25 FTS5 search behavior but with FTS5 syntax stripped before tokenization.
- TCVDB no longer receives SQLite-specific `OR` expressions as natural-language query text.

No schema migration is required.
