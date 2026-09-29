/**
 * Serialize writes for one CodeGraph across routes in this Panel process.
 *
 * A ready callback reads Knowledge before writing Core and meta. Delete must
 * wait for those writes, or the callback must read Knowledge after delete;
 * otherwise a slow callback can recreate records after the delete cascade.
 * Scope the key by service because Knowledge IDs are tenant scoped.
 *
 * This queue is process local. Separate Panel processes require a shared
 * lifecycle fence to guarantee the same ordering across processes.
 */
const tails = new Map<string, Promise<void>>();

export async function withCodeGraphLifecycleLock<T>(
  serviceId: string,
  codeGraphId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = JSON.stringify([serviceId, codeGraphId]);
  const previous = tails.get(key);
  let release!: () => void;
  const tail = new Promise<void>((resolve) => { release = resolve; });
  tails.set(key, tail);
  if (previous) await previous;
  try {
    return await operation();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

/**
 * Delete must not sit behind a long callback and then run after the caller's
 * HTTP deadline. Report busy immediately so the caller can retry explicitly.
 */
export async function tryWithCodeGraphLifecycleLock<T>(
  serviceId: string,
  codeGraphId: string,
  operation: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const key = JSON.stringify([serviceId, codeGraphId]);
  if (tails.has(key)) return { acquired: false };
  return { acquired: true, value: await withCodeGraphLifecycleLock(serviceId, codeGraphId, operation) };
}
