import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { zstdCompressSync } from 'node:zlib';

import { readZstdUtf8 } from './asset-import.ts';

test('dsh concatenated zstd session frames use the Node built-in decoder', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tdb-dsh-zstd-'));
  const path = join(directory, 'session.jsonl.zstd');
  const header = '{"type":"session","version":0,"id":"session-1"}\n';
  const event = '{"type":"user/message","data":{"content":"你好"}}\n';
  try {
    await writeFile(path, Buffer.concat([
      zstdCompressSync(Buffer.from(header)),
      zstdCompressSync(Buffer.from(event)),
    ]));
    assert.equal(readZstdUtf8(path), header + event);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
