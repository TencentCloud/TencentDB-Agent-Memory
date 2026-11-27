/** 领域错误。HTTP 层据此映射状态码。 */
export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number = 400,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class NotFoundError extends DomainError {
  constructor(what: string) {
    super(`${what} not found`, 'NOT_FOUND', 404);
  }
}

export class ForbiddenError extends DomainError {
  constructor(msg = 'forbidden') {
    super(msg, 'FORBIDDEN', 403);
  }
}

export class ConflictError extends DomainError {
  constructor(msg: string) {
    super(msg, 'CONFLICT', 409);
  }
}

/**
 * Core 上游错误的统一映射。skill-client 把 core 业务码（40001/40301/40401/...）
 * 翻译成本地 DomainError 子类，service / route 不必再判码。
 */
export class CoreUpstreamError extends DomainError {
  constructor(
    code: string,
    httpStatus: number,
    message: string,
    /** core 原始业务码，便于排查；不直接返给前端。 */
    readonly upstreamCode?: number,
    /** 上游的机器可读错误标识；供调用方区分可重试的查询间隙。 */
    readonly upstreamErrorCode?: string,
  ) {
    super(message, code, httpStatus);
    this.name = 'CoreUpstreamError';
  }
}
