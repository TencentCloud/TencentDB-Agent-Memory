export type DependencyStatus = 401 | 403 | 500 | 502 | 503 | 504;

export class DependencyError extends Error {
  constructor(public readonly status: DependencyStatus, message: string, public readonly upstreamStatus?: number) {
    super(message);
    this.name = "DependencyError";
  }
}

export function dependencyStatus(error: unknown, fallback: DependencyStatus = 502): DependencyStatus {
  if (error instanceof DependencyError) return error.status;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return 504;
  return fallback;
}

export function upstreamFailure(status: number): DependencyError {
  const mapped = status === 401 || status === 403 || status === 503 || status === 504 ? status : 502;
  return new DependencyError(mapped, `Required upstream returned HTTP ${status}`, status);
}
