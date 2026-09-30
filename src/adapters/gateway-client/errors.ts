export class GatewayMemoryClientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class GatewayConfigurationError extends GatewayMemoryClientError {}

export class GatewayTransportError extends GatewayMemoryClientError {
  readonly url: string;

  constructor(url: string, cause: unknown) {
    super(`Gateway request failed: ${url}`, { cause });
    this.url = url;
  }
}

export class GatewayTimeoutError extends GatewayTransportError {
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number, cause?: unknown) {
    super(url, cause);
    this.timeoutMs = timeoutMs;
    this.message = `Gateway request timed out after ${timeoutMs}ms: ${url}`;
  }
}

/**
 * The Gateway attempted to redirect the request.
 *
 * Redirects are deliberately rejected so a trusted loopback URL cannot move a
 * request (and its Bearer token) to an unvalidated destination.
 */
export class GatewayRedirectError extends GatewayMemoryClientError {
  readonly url: string;
  readonly status: number;
  readonly location?: string;

  constructor(url: string, status: number, location?: string) {
    super(
      `Gateway redirect rejected${location ? ` to ${location}` : ""}: ${url}`,
    );
    this.url = url;
    this.status = status;
    this.location = location;
  }
}

export class GatewayHttpError extends GatewayMemoryClientError {
  readonly status: number;
  readonly responseBody: string;
  readonly url: string;

  constructor(url: string, status: number, responseBody: string) {
    super(`Gateway returned HTTP ${status}: ${url}`);
    this.url = url;
    this.status = status;
    this.responseBody = responseBody;
  }
}

export class GatewayResponseError extends GatewayMemoryClientError {
  readonly url: string;
  readonly responseBody: string;
  readonly reason?: string;

  constructor(url: string, responseBody: string, cause?: unknown, reason?: string) {
    super(
      `Gateway returned an invalid response${reason ? ` (${reason})` : ""}: ${url}`,
      { cause },
    );
    this.url = url;
    this.responseBody = responseBody;
    this.reason = reason;
  }
}

/** The Gateway returned a successful HTTP response that was not valid JSON. */
export class GatewayParseError extends GatewayResponseError {
  constructor(url: string, responseBody: string, cause?: unknown) {
    super(url, responseBody, cause, "malformed JSON");
  }
}
