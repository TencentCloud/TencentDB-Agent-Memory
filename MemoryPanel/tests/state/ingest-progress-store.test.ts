import { describe, expect, it } from 'vitest';
import { IngestProgressStore, type IngestProgress } from '../../src/panel/state/ingest-progress-store.js';

function progress(phase: IngestProgress['phase'], percent: number, completed = percent): IngestProgress {
  return { phase, percent, completed, failed: 0, skipped: 0, total: 100 };
}

function fixture() {
  let now = 1000;
  return { store: new IngestProgressStore({ ttlMs: 100, now: () => now }), advance: (ms: number) => { now += ms; } };
}

describe('IngestProgressStore asynchronous update boundaries', () => {
  it('keeps phases and percentage monotonic within one run', () => {
    const { store } = fixture();
    store.update('wiki-a', progress('merging', 50), 'run-1');
    store.update('wiki-a', progress('extracting', 99), 'run-1');
    store.update('wiki-a', progress('merging', 49), 'run-1');
    expect(store.get('wiki-a')).toEqual(progress('merging', 50));
    store.update('wiki-a', progress('indexing', 0), 'run-1');
    expect(store.get('wiki-a')).toEqual(progress('indexing', 0));
  });

  it('accepts improved completion counts when rounded percentages are equal', () => {
    const { store } = fixture();
    store.update('wiki-a', progress('extracting', 10, 10), 'run-1');
    const improved = { ...progress('extracting', 10, 10), failed: 1 };
    store.update('wiki-a', improved, 'run-1');
    expect(store.get('wiki-a')).toEqual(improved);
  });

  it('allows a new run to restart from zero and isolates different wikis', () => {
    const { store } = fixture();
    store.update('wiki-a', progress('indexing', 98), 'run-1');
    store.update('wiki-b', progress('merging', 50), 'run-1');
    store.update('wiki-a', progress('extracting', 0), 'run-2');
    expect(store.get('wiki-a')).toEqual(progress('extracting', 0));
    expect(store.get('wiki-b')).toEqual(progress('merging', 50));
  });

  it('rejects late cleared-run and legacy packets after starting a newer run', () => {
    const { store } = fixture();
    store.update('wiki-a', progress('indexing', 98), 'run-1');
    store.clear('wiki-a', 'run-1');
    store.update('wiki-a', progress('extracting', 0), 'run-2');
    store.update('wiki-a', progress('indexing', 99), 'run-1');
    store.update('wiki-a', progress('indexing', 99));
    expect(store.get('wiki-a')).toEqual(progress('extracting', 0));
  });

  it('keeps a newer run when an older terminal callback arrives late', () => {
    const { store } = fixture();
    store.update('wiki-a', progress('indexing', 98), 'run-1');
    store.update('wiki-a', progress('extracting', 20), 'run-2');
    store.clear('wiki-a', 'run-1');
    expect(store.get('wiki-a')).toEqual(progress('extracting', 20));
    store.update('wiki-a', progress('indexing', 99), 'run-1');
    expect(store.get('wiki-a')).toEqual(progress('extracting', 20));
  });

  it('clears the current run and suppresses its late progress even without an explicit run ID', () => {
    const { store } = fixture();
    store.update('wiki-a', progress('indexing', 98), ' run-1 ');
    store.clear('wiki-a');
    store.update('wiki-a', progress('indexing', 99), 'run-1');
    expect(store.get('wiki-a')).toBeNull();
  });

  it('expires abandoned progress and permits recovery after the cleared-run TTL', () => {
    const { store, advance } = fixture();
    store.update('wiki-a', progress('indexing', 98), 'run-1');
    advance(101);
    expect(store.get('wiki-a')).toBeNull();
    store.clear('wiki-a', 'run-1');
    store.update('wiki-a', progress('extracting', 0), 'run-1');
    expect(store.get('wiki-a')).toBeNull();
    advance(101);
    store.update('wiki-a', progress('extracting', 0), 'run-1');
    expect(store.get('wiki-a')).toEqual(progress('extracting', 0));
  });
});
