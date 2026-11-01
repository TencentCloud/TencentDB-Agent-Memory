# @tencentdb-agent-memory/tcvdb-text

TypeScript port of [`tcvdb_text`](https://github.com/Tencent/vectordatabase-sdk-python) — BM25 sparse vector encoder for [Tencent Cloud VectorDB](https://cloud.tencent.com/product/vdb).

Encodes text into sparse vectors compatible with VectorDB's `hybridSearch` interface.

## Installation

```bash
npm install @tencentdb-agent-memory/tcvdb-text
```

## Usage

### Use the built-in default model (recommended)

```ts
import { BM25Encoder } from "@tencentdb-agent-memory/tcvdb-text";

// Load pre-trained Chinese model
const encoder = BM25Encoder.default("zh"); // or "en" for English

// Encode a document (for indexing)
const docVector = encoder.encodeTexts("腾讯云向量数据库是一款全托管的向量检索服务");
// => [[tokenId, weight], ...]

// Encode a query (for searching)
const queryVector = encoder.encodeQueries("向量数据库");
// => [[tokenId, weight], ...]

// Batch encoding
const docVectors = encoder.encodeTexts(["文档一", "文档二"]);
const queryVectors = encoder.encodeQueries(["查询一", "查询二"]);
```

### Train on your own corpus

```ts
import { BM25Encoder } from "@tencentdb-agent-memory/tcvdb-text";

const encoder = new BM25Encoder();

// Fit on your corpus
encoder.fitCorpus([
  "腾讯云向量数据库支持混合检索",
  "BM25 是一种经典的稀疏检索算法",
  "稀疏向量与稠密向量结合可以提升检索效果",
]);

// Save trained params to file
encoder.downloadParamsSync("./my_bm25_params.json");

// Load params later
const encoder2 = new BM25Encoder();
await encoder2.setParams("./my_bm25_params.json");
```

### Custom tokenizer

```ts
import { BM25Encoder, JiebaTokenizer, Hash } from "@tencentdb-agent-memory/tcvdb-text";

const tokenizer = new JiebaTokenizer({
  hashFunction: Hash.mmh3Hash,
  stopWords: true,
  lowerCase: true,
});

const encoder = new BM25Encoder({ tokenizer, b: 0.75, k1: 1.2 });
```

## API

### `BM25Encoder`

| Method | Description |
|--------|-------------|
| `BM25Encoder.default(name)` | Load pre-trained model. `name`: `"zh"` (default) or `"en"` |
| `fitCorpus(corpus)` | Train on a string or array of strings. Supports incremental training |
| `encodeTexts(texts)` | Encode document(s) into sparse vectors (TF-weighted) |
| `encodeQueries(texts)` | Encode query/queries into sparse vectors (IDF-weighted, normalized) |
| `downloadParamsSync(path)` | Save trained params to a JSON file |
| `setParamsSync(path)` | Load params from a JSON file (sync) |
| `setParams(path)` | Load params from a JSON file (async) |
| `setDict(dictFile)` | Load a custom Jieba dictionary |

### `SparseVector`

```ts
type SparseVector = Array<[number, number]>; // [tokenId, weight]
```

Compatible with Tencent Cloud VectorDB `hybridSearch` `match.data` format.

## Requirements

- Node.js >= 18

## License

MIT
