import { File } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { readUploadFile, uploadWikiFiles } from '../web/src/pages/WikiPage/utils/wiki-upload-utils';

function file(relativePath: string, content: string) {
  const value = new File([content], relativePath.split('/').at(-1)!);
  Object.defineProperty(value, 'webkitRelativePath', { value: relativePath });
  return value as unknown as globalThis.File;
}

describe('Wiki folder uploads', () => {
  it('keeps the folder root and subdirectories for same-basename documents', async () => {
    const documents = [
      file('handbook/team-a/README.md', 'alpha'),
      file('handbook/team-b/README.md', 'beta'),
    ];
    const uploads = await Promise.all(documents.map(readUploadFile));
    expect(uploads.map((item) => item.filename)).toEqual([
      'handbook/team-a/README.md',
      'handbook/team-b/README.md',
    ]);
    expect(uploads.map((item) => Buffer.from(item.content, 'base64').toString())).toEqual([
      'alpha',
      'beta',
    ]);
  });
});

describe('bounded, retryable folder uploads', () => {
  it('uploads more than ten documents in order and queues extraction only after every batch succeeds', async () => {
    const docs = Array.from({ length: 23 }, (_, i) =>
      file(`handbook/section-${i}/README.md`, `${i}`),
    );
    const events: string[] = [];
    const batches: string[][] = [];
    const finish = vi.fn(async () => {
      events.push('ingest');
      return 'accepted';
    });
    await expect(
      uploadWikiFiles(
        docs,
        async (items) => {
          events.push('write');
          batches.push(items.map((i) => i.filename));
        },
        finish,
      ),
    ).resolves.toBe('accepted');
    expect(batches.map((b) => b.length)).toEqual([10, 10, 3]);
    expect(batches.flat()).toEqual(docs.map((f) => f.webkitRelativePath));
    expect(events).toEqual(['write', 'write', 'write', 'ingest']);
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it('bounds decoded bytes and waits for acknowledgement before reading later batches', async () => {
    const docs = [file('root/a.pdf', 'a'), file('root/b.pdf', 'b'), file('root/c.pdf', 'c')];
    for (const doc of docs) Object.defineProperty(doc, 'size', { value: 8 * 1024 * 1024 });
    const readLast = vi.spyOn(docs[2], 'arrayBuffer');
    const sizes: number[] = [];
    await uploadWikiFiles(
      docs,
      async (items) => {
        if (!sizes.length) expect(readLast).not.toHaveBeenCalled();
        sizes.push(items.length);
      },
      async () => {},
    );
    expect(sizes).toEqual([2, 1]);
    expect(readLast).toHaveBeenCalledOnce();
  });

  it('replays stable paths after a lost acknowledgement without duplicates or premature extraction', async () => {
    const docs = Array.from({ length: 12 }, (_, i) => file(`root/${i}/README.md`, `body-${i}`));
    const persisted = new Map<string, string>();
    let attempts = 0;
    const finish = vi.fn(async () => {});
    const write = async (items: Awaited<ReturnType<typeof readUploadFile>>[]) => {
      for (const item of items) persisted.set(item.filename, item.content);
      if (++attempts === 2) throw new Error('connection lost after commit');
    };
    await expect(uploadWikiFiles(docs, write, finish)).rejects.toThrow('connection lost');
    expect(finish).not.toHaveBeenCalled();
    await uploadWikiFiles(docs, write, finish);
    expect(persisted.size).toBe(12);
    for (const [i, doc] of docs.entries())
      expect(Buffer.from(persisted.get(doc.webkitRelativePath)!, 'base64').toString()).toBe(
        `body-${i}`,
      );
    expect(finish).toHaveBeenCalledOnce();
  });

  it('allows the same selection to retry when enqueueing extraction fails', async () => {
    const docs = [file('root/readme.md', 'body')];
    const write = vi.fn(async () => {});
    const finish = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue('accepted');
    await expect(uploadWikiFiles(docs, write, finish)).rejects.toThrow('offline');
    await expect(uploadWikiFiles(docs, write, finish)).resolves.toBe('accepted');
    expect(write.mock.calls).toHaveLength(2);
    expect(write.mock.calls[0]).toEqual(write.mock.calls[1]);
  });

  it.each([
    'root/../escape.md',
    '/absolute.md',
    'root//alias.md',
    'root/./alias.md',
    'root\\escape.md',
    'root/\0.md',
  ])('rejects invalid path %s before uploading any valid files', async (invalid) => {
    const write = vi.fn();
    const finish = vi.fn();
    await expect(
      uploadWikiFiles([file('root/valid.md', 'ok'), file(invalid, 'bad')], write, finish),
    ).rejects.toThrow('Invalid file path');
    expect(write).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it.each([
    ['root/a.md', 'root/A.md'],
    ['root/café.md', 'root/cafe\u0301.md'],
  ])('rejects paths that alias on common filesystems: %s and %s', async (a, b) => {
    const write = vi.fn();
    await expect(uploadWikiFiles([file(a, 'a'), file(b, 'b')], write, vi.fn())).rejects.toThrow(
      'Conflicting file paths',
    );
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects an oversized file before reading or uploading any bytes', async () => {
    const doc = file('root/large.pdf', 'small fixture');
    Object.defineProperty(doc, 'size', { value: 20 * 1024 * 1024 + 1 });
    const read = vi.spyOn(doc, 'arrayBuffer');
    const write = vi.fn();
    await expect(uploadWikiFiles([doc], write, vi.fn())).rejects.toThrow('20 MB');
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps loose-file names and arbitrary binary bytes intact', async () => {
    const doc = new File(
      [new Uint8Array([0, 255, 128, 10])],
      'file.pdf',
    ) as unknown as globalThis.File;
    const result = await readUploadFile(doc);
    expect(result.filename).toBe('file.pdf');
    expect([...Buffer.from(result.content, 'base64')]).toEqual([0, 255, 128, 10]);
  });
});
