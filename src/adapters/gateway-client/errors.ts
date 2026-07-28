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
