const DEFAULT_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 60_000;

export class CircuitBreaker {
  private consecutiveFailures = 0;
  private openUntilMs = 0;

  constructor(
    private readonly threshold = DEFAULT_THRESHOLD,
    private readonly cooldownMs = DEFAULT_COOLDOWN_MS,
    private readonly now: () => number = Date.now,
  ) {}

  isOpen(): boolean {
    if (this.openUntilMs === 0) return false;
    if (this.now() < this.openUntilMs) return true;
    this.openUntilMs = 0;
    this.consecutiveFailures = 0;
    return false;
  }

  success(): void {
    this.consecutiveFailures = 0;
    this.openUntilMs = 0;
  }

  failure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.threshold) {
      this.openUntilMs = this.now() + this.cooldownMs;
    }
  }
}
