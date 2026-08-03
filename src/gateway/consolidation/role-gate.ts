/**
 * RoleGate — per-role single-flight (§5.1).
 *
 * One critical section per ROLE at a time; different roles (memory-keeper,
 * night-keeper, dedup-daily) run in parallel. Same-role overlap gets `null`
 * from tryAcquire. The release function is idempotent (a second call is a
 * no-op) so a deferred handler can't double-release.
 */

export class RoleGate {
  private locked = new Map<string, boolean>();

  /** True when ANY role has an active run (for /status inFlight). */
  get isLocked(): boolean {
    return this.locked.size > 0;
  }

  /** True when a specific role has an active run. */
  isRoleLocked(role: string): boolean {
    return this.locked.get(role) === true;
  }

  /** Acquire the gate for a role; returns a release function or null when
   * that role is already running. */
  tryAcquire(role: string): (() => void) | null {
    if (this.locked.get(role) === true) return null;
    this.locked.set(role, true);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.locked.delete(role);
    };
  }
}
