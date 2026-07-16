# FTS 查询安全设计

## 背景

记忆插件目前通过两类存储实现关键字召回：

- SQLite：本地 FTS5 表，使用 `MATCH ?` 查询。
- TCVDB：远端 hybrid search，使用原始自然语言 `queryText` 做 dense embedding 和 BM25 sparse matching。

历史实现中，上层调用方会先通过 `buildFtsQuery()` 构造 SQLite FTS5 表达式，然后把该字符串传给 `searchL1Fts()` / `searchL0Fts()`。这导致 SQLite 专属查询语法泄漏到 store 抽象之外，也造成了接口语义不一致：同一个参数对 `sqlite.ts` 来说是合法的 SQLite `MATCH` 表达式，但对 `tcvdb.ts` 来说却应该是自然语言文本。

本次修复目标是：防止 SQLite FTS5 查询语法被用户输入篡改，同时保留 TCVDB 自然语言召回质量。

## 方案对比

### 方案一：查询白名单

白名单/清洗方案会移除或转义已知具有 FTS5 语法含义的字符和关键字，例如：

- `"`
- `'`
- `(`
- `)`
- `*`
- `^`
- `AND` / `OR` / `NOT` / `NEAR`，大小写不敏感
- `title:apple` 这类字段限定语法
- `apple -banana` 这类排除语法
- 其他可能影响 `MATCH` 解析的标点和符号

优点：

- 改动面小。
- 容易理解。
- 适合作为分词前的纵深防御。

局限：

- 本质是字符串过滤，依赖我们持续维护“哪些语法危险”的规则。
- 规则过宽时可能误删合法用户文本。
- 无法解决非 SQLite store 收到 SQLite 查询语法的抽象泄漏问题。
- 随着 FTS 语法或分词器行为变化，正确性更难证明。

### 方案二：参数化查询边界

参数化查询边界的核心是：用户输入在跨 store 接口层始终保持为“数据”，直到具体 store 实现进入自己的查询边界。

在当前代码结构中，这意味着：

- 调用方只把原始自然语言查询传给 `IMemoryStore.searchL1Fts()` 和 `searchL0Fts()`。
- SQLite 内部负责构造 FTS5 `MATCH` 表达式。
- SQLite 通过 prepared statement 绑定生成后的 FTS5 表达式：`WHERE l1_fts MATCH ?` / `WHERE l0_fts MATCH ?`。
- TCVDB 接收未经 SQLite 语法污染的原始 query，用于 BM25 和 embedding。
- SQLite 内部仍保留清洗逻辑，但它是纵深防御，不再是跨 store 接口契约。

优点：

- store 专属语法不再泄漏到 hook、tool、dedup 等上层逻辑。
- TCVDB 不再收到 `"term" OR "term2"` 这类 SQLite 表达式作为 BM25 输入。
- SQL 语句保持参数化，用户输入不会拼接进 SQL 文本。
- 调用方契约更简单：传 raw query，拿 ranked results。
- SQLite 专属行为集中在 `sqlite.ts`，测试边界更清晰。

局限：

- SQLite FTS5 的 `MATCH` 只接受一个表达式参数，无法把每个 term 都拆成独立 SQL placeholder。
- SQLite 仍然需要内部生成合法 FTS5 表达式；关键边界是：表达式由受控分词结果生成，并作为参数绑定到 prepared statement。

## 推荐方案

采用“参数化查询边界”方案。

仅做白名单清洗不够，因为核心问题是架构层面的：上层调用方被迫理解 SQLite FTS5 查询语法，即使当前实际 store 可能是 TCVDB。更稳妥的设计是把 raw query 作为跨 store API，SQLite FTS5 表达式生成只保留在 SQLite 实现内部。

SQLite 内部仍应保留清洗逻辑作为纵深防御：

- 分词前移除 FTS5 操作符，包括用户输入的小写 operator。
- 分词前把非 token 标点和符号当作分隔符。
- 优先使用 jieba 分词。
- 丢弃纯标点 token 和停用词。
- 将每个 token 包成 FTS5 phrase term。
- 最终表达式通过 `MATCH ?` 绑定执行。

## 已实现设计

### Store 接口

`IMemoryStore` 现在把 FTS 搜索输入视为原始文本：

```ts
searchL1Fts(query: string, limit?: number): MaybePromise<L1FtsResult[]>;
searchL0Fts(query: string, limit?: number): MaybePromise<L0FtsResult[]>;
```

接口不再暴露 SQLite 专属的 `ftsQuery` 概念。

### SQLite Store

`sqlite.ts` 将 `buildFtsQuery()` 收敛到 SQLite 实现路径内：

1. `searchL1Fts(query, limit)` 接收原始用户文本。
2. 内部调用 `buildFtsQuery(query)`。
3. 如果分词后没有可用 token，返回空结果。
4. 使用现有 prepared statement 绑定参数执行：

```sql
WHERE l1_fts MATCH ?
LIMIT ?
```

`searchL0Fts()` 使用同样流程。

`buildFtsQuery()` 在分词前做清洗：

- 独立 FTS5 操作符大小写不敏感清理：`AND`、`OR`、`NOT`、`NEAR`
- 将非 token 标点和符号作为分隔符，包括 `:`、`-`、`\`、逗号、CJK 标点、emoji
- 保留普通单词内部的 operator 子串，例如 `ordinary`、`northeast`

### TCVDB Store

`tcvdb.ts` 接收同样的原始 `query` 参数，并直接传给 hybrid search：

```ts
this.searchL1HybridAsync({ queryText: query, topK: limit });
this.searchL0HybridAsync({ queryText: query, topK: limit });
```

这样可以保持 TCVDB 召回质量，因为 BM25 和 embedding 看到的是自然语言输入，而不是 SQLite FTS5 表达式。

### 上层调用方

以下层级现在都直接把 raw query 传给 store：

- `auto-recall.ts`
- `memory-search.ts`
- `conversation-search.ts`
- `l1-dedup.ts`

这些文件不再导入 `buildFtsQuery()`，也不再记录或操作 SQLite FTS5 表达式。

## 测试计划

单元测试覆盖：

- 基础语法字符清理
- 所有支持的 FTS5 操作符
- 普通单词内部 operator 子串不应被误删
- 小写 FTS5 操作符，例如 `and`、`or`、`not`、`near`
- 字段限定、排除语法、反斜杠、逗号、CJK 标点、emoji、连续引号
- 输入仅包含 FTS 语法时返回空结果
- jieba 路径在分词前完成清洗
- 清洗前后 recall 相关 token 等价
- L1 / L0 真实 SQLite `MATCH ?` FTS 搜索执行
- 写入侧 `tokenizeForFts()` 与查询侧 `buildFtsQuery()` 的分词一致性
- 从 metadata 表重建 FTS index
- FTS v1 到 v2 的迁移和重建

超长输入和重复 token 的性能优化不属于本次安全修复范围。

验证命令：

```bash
npm.cmd test -- src/core/store/sqlite.test.ts
npm.cmd test
npm.cmd run build
```

## 发布说明

该变更对仓库内调用方是源码兼容的，因为调用方现在统一传 raw query。行为上对两个 store 都更安全：

- SQLite 保持原有 BM25 FTS5 搜索能力，但在分词前清理 FTS5 语法。
- TCVDB 不再收到 SQLite 专属 `OR` 表达式作为自然语言 query。

不需要数据库 schema migration。
