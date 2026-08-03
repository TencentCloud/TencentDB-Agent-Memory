/**
 * SerialGate — single-flight (§5.1).
 *
 * One critical section at a time; others get `null` from tryAcquire.
 * The release function is idempotent (a second call is a no-op) so a
 * deferred handler can't double-release.
 */

export class SerialGate {
  private locked = false;

  get isLocked(): boolean {
    return this.locked;
  }

  /** Acquire the gate; returns a release function or null when busy. */
  tryAcquire(): (() => void) | null {
    if (this.locked) return null;
    this.locked = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.locked = false;
    };
  }
}
