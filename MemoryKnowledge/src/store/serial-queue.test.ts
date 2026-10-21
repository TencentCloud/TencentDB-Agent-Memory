import { describe, expect, it, vi } from 'vitest';
import { SerialQueue } from './serial-queue.js';
import { BuildQueue } from './build-queue.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('SerialQueue lifecycle', () => {
  it('runs jobs FIFO, one at a time, and resolves every idle waiter', async () => {
    const queue = new SerialQueue();
    const gate = deferred();
    const events: string[] = [];
    const first = queue.add(async () => {
      events.push('first:start');
      await gate.promise;
      events.push('first:end');
      return 1;
    });
    const second = queue.add(async () => { events.push('second'); return 2; });
    const idle1 = queue.onIdle();
    const idle2 = queue.onIdle();
    expect(events).toEqual(['first:start']);
    expect(queue.pending).toBe(true);
    expect(queue.size).toBe(1);
    gate.resolve();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    await Promise.all([idle1, idle2]);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
    expect(queue.idle).toBe(true);
    expect(queue.pending).toBe(false);
  });

  it('pause lets the active task finish but holds queued work until start', async () => {
    const queue = new SerialQueue();
    const gate = deferred();
    const first = queue.add(() => gate.promise);
    const next = vi.fn(async () => 'next');
    const second = queue.add(next);
    queue.pause();
    gate.resolve();
    await first;
    await vi.waitFor(() => expect(queue.pending).toBe(false));
    expect(next).not.toHaveBeenCalled();
    expect(queue.size).toBe(1);
    queue.start();
    expect(await second).toBe('next');
    await queue.onIdle();
  });

  it('continues after a rejected task and preserves its original error', async () => {
    const queue = new SerialQueue();
    const error = new Error('failed build');
    const first = queue.add(async () => { throw error; });
    const second = queue.add(async () => 'recovered');
    await expect(first).rejects.toBe(error);
    await expect(second).resolves.toBe('recovered');
    await queue.onIdle();
  });

  it('continues after a task throws synchronously', async () => {
    const queue = new SerialQueue();
    const error = new Error('invalid job');
    await expect(queue.add(() => { throw error; })).rejects.toBe(error);
    // Observe the public scheduling contract without leaving a hanging test.
    const next = vi.fn(async () => 'recovered');
    const second = queue.add(next);
    await Promise.resolve();
    expect(next).toHaveBeenCalledOnce();
    await expect(second).resolves.toBe('recovered');
    await queue.onIdle();
  });

  it('clear on a paused queue rejects queued jobs and releases idle waiters', async () => {
    const queue = new SerialQueue();
    queue.pause();
    const job = vi.fn(async () => 1);
    const result = queue.add(job);
    const rejection = expect(result).rejects.toThrow('Queue cleared');
    const idle = vi.fn();
    const waiting = queue.onIdle().then(idle);
    queue.clear();
    await rejection;
    await Promise.resolve();
    expect(queue.idle).toBe(true);
    expect(idle).toHaveBeenCalledOnce();
    expect(job).not.toHaveBeenCalled();
    await waiting;
  });

  it('clear never cancels the running job or reports idle before it finishes', async () => {
    const queue = new SerialQueue();
    const gate = deferred();
    const active = queue.add(() => gate.promise);
    const rejected = expect(queue.add(async () => 'discard')).rejects.toThrow('Queue cleared');
    const idle = vi.fn();
    const waiting = queue.onIdle().then(idle);
    queue.clear();
    await rejected;
    expect(queue.pending).toBe(true);
    expect(idle).not.toHaveBeenCalled();
    gate.resolve();
    await active;
    await waiting;
    expect(idle).toHaveBeenCalledOnce();
  });
});

describe('BuildQueue asset boundaries', () => {
  it('serializes a single asset while allowing another asset to build', async () => {
    const queue = new BuildQueue();
    const gate = deferred();
    const events: string[] = [];
    queue.enqueue('wiki-a', async () => { events.push('a1'); await gate.promise; });
    queue.enqueue('wiki-a', async () => { events.push('a2'); });
    queue.enqueue('wiki-b', async () => { events.push('b'); });
    await queue.onIdle('wiki-b');
    expect(events).toEqual(['a1', 'b']);
    gate.resolve();
    await queue.onIdle();
    expect(events).toEqual(['a1', 'b', 'a2']);
  });

  it('a failed build does not block the next build of that asset', async () => {
    const queue = new BuildQueue();
    const next = vi.fn(async () => {});
    queue.enqueue('wiki', async () => { throw new Error('index failed'); });
    queue.enqueue('wiki', next);
    await queue.onIdle();
    expect(next).toHaveBeenCalledOnce();
    await expect(queue.onIdle('unknown')).resolves.toBeUndefined();
  });
});
