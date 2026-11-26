/**
 * Regression tests for issue #1935: a stale default-agent-template request
 * (team A) must not overwrite the view of the newly selected team (team B).
 *
 * Mirrors how DefaultAgentTemplateSection drives runLatestRequest: every
 * team switch starts a new request on the same guard, and the effect cleanup
 * (switch / unmount) calls guard.cancel().
 */
import { describe, expect, it } from 'vitest';
import {
  canEditTemplate,
  createLatestRequestGuard,
  runLatestRequest,
  type LatestRequestGuard,
} from '../web/src/lib/latest-request';

interface Template {
  name: string;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Minimal stand-in for the component state written by the load handlers. */
function createView() {
  const view = {
    template: null as Template | null,
    loading: true,
    errors: [] as unknown[],
    writes: 0,
  };
  function load(guard: LatestRequestGuard, request: () => Promise<Template>) {
    return runLatestRequest(guard, request, {
      onStart: () => {
        view.template = null;
        view.loading = true;
      },
      onSuccess: (data) => {
        view.writes++;
        view.template = data;
      },
      onError: (err) => {
        view.writes++;
        view.errors.push(err);
        view.template = null;
      },
      onSettled: () => {
        view.loading = false;
      },
    });
  }
  return { view, load };
}

describe('latest-request guard (issue #1935)', () => {
  it('A then B, B resolves first and A last: only B is kept', async () => {
    const guard = createLatestRequestGuard();
    const { view, load } = createView();
    const a = deferred<Template>();
    const b = deferred<Template>();

    const pa = load(guard, () => a.promise);
    const pb = load(guard, () => b.promise);

    b.resolve({ name: 'team-B' });
    await pb;
    expect(view.template).toEqual({ name: 'team-B' });
    expect(view.loading).toBe(false);

    a.resolve({ name: 'team-A' });
    await pa;
    expect(view.template).toEqual({ name: 'team-B' });
    expect(view.loading).toBe(false);
    expect(view.writes).toBe(1);
  });

  it('A resolving before B does not leak A or end loading for B', async () => {
    const guard = createLatestRequestGuard();
    const { view, load } = createView();
    const a = deferred<Template>();
    const b = deferred<Template>();

    const pa = load(guard, () => a.promise);
    const pb = load(guard, () => b.promise);

    a.resolve({ name: 'team-A' });
    await pa;
    expect(view.template).toBeNull();
    expect(view.loading).toBe(true);
    expect(canEditTemplate(view.loading)).toBe(false);

    b.resolve({ name: 'team-B' });
    await pb;
    expect(view.template).toEqual({ name: 'team-B' });
    expect(canEditTemplate(view.loading)).toBe(true);
  });

  it('stale A failure neither clears B nor reports an error', async () => {
    const guard = createLatestRequestGuard();
    const { view, load } = createView();
    const a = deferred<Template>();
    const b = deferred<Template>();

    const pa = load(guard, () => a.promise);
    const pb = load(guard, () => b.promise);

    b.resolve({ name: 'team-B' });
    await pb;
    a.reject(new Error('team A failed'));
    await pa;

    expect(view.template).toEqual({ name: 'team-B' });
    expect(view.errors).toEqual([]);
    expect(view.loading).toBe(false);
  });

  it('current request failure is still reported', async () => {
    const guard = createLatestRequestGuard();
    const { view, load } = createView();
    const err = new Error('team B failed');
    await load(guard, () => Promise.reject(err));
    expect(view.errors).toEqual([err]);
    expect(view.template).toBeNull();
    expect(view.loading).toBe(false);
  });

  it('after cancel (switch / unmount) a pending response writes nothing', async () => {
    const guard = createLatestRequestGuard();
    const { view, load } = createView();
    const a = deferred<Template>();
    const b = deferred<Template>();

    const pa = load(guard, () => a.promise);
    guard.cancel(); // effect cleanup on unmount
    a.resolve({ name: 'team-A' });
    await pa;
    expect(view.writes).toBe(0);
    expect(view.template).toBeNull();
    expect(view.loading).toBe(true);

    const pb = load(guard, () => b.promise);
    guard.cancel();
    b.reject(new Error('late failure'));
    await pb;
    expect(view.writes).toBe(0);
    expect(view.errors).toEqual([]);
  });

  it('a request started after cancel is current again (StrictMode re-run)', async () => {
    const guard = createLatestRequestGuard();
    const { view, load } = createView();
    const first = deferred<Template>();
    const pFirst = load(guard, () => first.promise);
    guard.cancel(); // StrictMode cleanup
    const pSecond = load(guard, () => Promise.resolve({ name: 'team-B' }));
    first.resolve({ name: 'team-B-stale' });
    await Promise.all([pFirst, pSecond]);
    expect(view.template).toEqual({ name: 'team-B' });
    expect(view.writes).toBe(1);
  });

  it('editing is disabled while loading', () => {
    expect(canEditTemplate(true)).toBe(false);
    expect(canEditTemplate(false)).toBe(true);
  });
});
