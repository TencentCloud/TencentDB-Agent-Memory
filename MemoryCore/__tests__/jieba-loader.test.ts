import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Fresh processes isolate native caches and enforcement flags from other tests.
function run(body: string, source = false) {
  const env: NodeJS.ProcessEnv = { ...process.env, NAPI_RS_ENFORCE_VERSION_CHECK: "1" };
  delete env.NAPI_RS_NATIVE_LIBRARY_PATH;
  delete env.NAPI_RS_FORCE_WASI;
  delete env.NAPI_RS_WASI_FLAVOR;
  const result = spawnSync(process.execPath,
    [...(source ? ["--import", "tsx/esm"] : []), "--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      const require = createRequire(new URL('./package.json', 'file://' + process.cwd() + '/'));
      const packageRequire = createRequire(require.resolve('@node-rs/jieba/package.json'));
      ${body}
    `], { env, encoding: "utf8", timeout: 30_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}

describe("licensed Jieba loader adapter", () => {
  it("keeps native initialization lazy and segments with version enforcement", () => run(`
    const nativePaths = Object.keys(packageRequire('@node-rs/jieba/package.json').optionalDependencies)
      .flatMap(name => { try { return [packageRequire.resolve(name)]; } catch { return []; } });
    assert(nativePaths.length > 0, 'test needs a platform native binding');
    const load = require('#jieba-loader');
    for (const path of nativePaths) assert.equal(require.cache[path], undefined);
    const {Jieba} = load(packageRequire);
    const {dict} = packageRequire('@node-rs/jieba/dict');
    assert(Jieba.withDict(dict).cutForSearch('南京市长江大桥', true).length > 1);
  `));

  it("rejects mismatched native metadata without disabling enforcement", () => run(`
    const load = require('#jieba-loader');
    const altered = id => (id.startsWith('@node-rs/jieba-') && id.endsWith('/package.json'))
      ? {version:'0.0.0'} : packageRequire(id);
    altered.resolve = packageRequire.resolve;
    assert.throws(() => load(altered));
    assert.equal(process.env.NAPI_RS_ENFORCE_VERSION_CHECK, '1');
  `));

  it("rejects an unreviewed main-package version before native loading", () => run(`
    const load = require('#jieba-loader');
    let nativeRequests = 0;
    const altered = id => {
      if (id === '@node-rs/jieba/package.json') return {version:'2.0.4'};
      nativeRequests++; return packageRequire(id);
    };
    altered.resolve = packageRequire.resolve;
    assert.throws(() => load(altered), /Unsupported Jieba loader package version/);
    assert.equal(nativeRequests, 0);
  `));

  it("preserves the official installed loader bytes", () => run(`
    const {readFileSync} = require('node:fs');
    const {createHash} = require('node:crypto');
    const path = packageRequire.resolve('@node-rs/jieba');
    const before = readFileSync(path);
    assert.equal(createHash('sha256').update(before).digest('hex'),
      '66142a6f48caafba6851216935720526cc55037506cde62d6098aedb165fdc53');
    require('#jieba-loader')(packageRequire);
    assert.deepEqual(readFileSync(path), before);
  `));

  it("uses native segmentation through the actual source tokenizer", () => run(`
    const {tokenizeForFts} = await import('./src/core/store/tokenize.ts');
    const text = '南京市长江大桥';
    assert.notEqual(tokenizeForFts(text), text);
    assert(tokenizeForFts(text).includes(' '));
  `, true));
});
