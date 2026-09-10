import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  CoreUpstreamError,
  DomainError,
  ForbiddenError,
  NotFoundError,
} from '../../src/panel/domain/errors.js';

describe('DomainError', () => {
  it('sets name/code/httpStatus', () => {
    const e = new DomainError('boom', 'BAD', 422);
    expect(e.name).toBe('DomainError');
    expect(e.message).toBe('boom');
    expect(e.code).toBe('BAD');
    expect(e.httpStatus).toBe(422);
    expect(e).toBeInstanceOf(Error);
  });

  it('defaults httpStatus to 400', () => {
    expect(new DomainError('x', 'X').httpStatus).toBe(400);
  });
});

describe('error subclasses', () => {
  it('NotFoundError', () => {
    const e = new NotFoundError('team');
    expect(e.code).toBe('NOT_FOUND');
    expect(e.httpStatus).toBe(404);
    expect(e.message).toBe('team not found');
  });

  it('ForbiddenError', () => {
    const e = new ForbiddenError();
    expect(e.code).toBe('FORBIDDEN');
    expect(e.httpStatus).toBe(403);
    expect(e.message).toBe('forbidden');
  });

  it('ConflictError', () => {
    const e = new ConflictError('already exists');
    expect(e.code).toBe('CONFLICT');
    expect(e.httpStatus).toBe(409);
  });
});

describe('CoreUpstreamError', () => {
  it('carries upstreamCode while mapping to a local code', () => {
    const e = new CoreUpstreamError('FORBIDDEN', 403, 'no permission', 40301);
    expect(e).toBeInstanceOf(DomainError);
    expect(e.name).toBe('CoreUpstreamError');
    expect(e.code).toBe('FORBIDDEN');
    expect(e.httpStatus).toBe(403);
    expect(e.upstreamCode).toBe(40301);
  });

  it('upstreamCode is optional', () => {
    const e = new CoreUpstreamError('NOT_FOUND', 404, 'missing');
    expect(e.upstreamCode).toBeUndefined();
  });
});
