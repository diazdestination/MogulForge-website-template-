import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createFailureLimiter } from '../lib/rateLimit';
import { invalidAuthAttemptLimiter } from './auth';

// ---------------------------------------------------------------------------
// Mock openid-client so authorizationCodeGrant throws without a real provider
// ---------------------------------------------------------------------------
vi.mock('openid-client', async (importOriginal) => {
  const real = await importOriginal<typeof import('openid-client')>();
  return {
    ...real,
    authorizationCodeGrant: vi.fn().mockRejectedValue(new Error('invalid_grant')),
  };
});

// Mock getOidcConfig — the routes only need a truthy config object when the
// mocked authorizationCodeGrant never inspects it.
vi.mock('../lib/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/auth')>();
  return {
    ...real,
    getOidcConfig: vi.fn().mockResolvedValue({ issuer: 'https://mock.example' }),
  };
});

import app from '../app';

const INVALID_AUTH_MAX_FAILURES = 10;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  invalidAuthAttemptLimiter.reset();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  invalidAuthAttemptLimiter.reset();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mobileExchange(overrides?: Record<string, string>) {
  const body = {
    code: 'test-code',
    code_verifier: 'test-verifier',
    redirect_uri: 'https://example.com/callback',
    state: 'test-state',
    nonce: 'test-nonce',
    ...overrides,
  };
  return fetch(`${baseUrl}/mobile-auth/token-exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// HTTP throttle on the mobile token-exchange endpoint
// ---------------------------------------------------------------------------

describe('POST /mobile-auth/token-exchange — brute-force throttling', () => {
  it('returns 500 on each failed exchange until the budget is spent, then 429', async () => {
    // Every request uses a bad code that authorizationCodeGrant rejects with
    // 500. Once the failure budget is exhausted the limiter cuts in with 429.
    const statuses: number[] = [];
    for (let i = 0; i < INVALID_AUTH_MAX_FAILURES + 1; i++) {
      const res = await mobileExchange({ code: `code-${i}` });
      statuses.push(res.status);
    }

    // First N failures should be 500 (auth error); the next one is 429.
    expect(statuses.slice(0, INVALID_AUTH_MAX_FAILURES)).toEqual(
      Array(INVALID_AUTH_MAX_FAILURES).fill(500),
    );
    expect(statuses[INVALID_AUTH_MAX_FAILURES]).toBe(429);
  });

  it('continues to return 429 for subsequent requests once blocked', async () => {
    for (let i = 0; i < INVALID_AUTH_MAX_FAILURES; i++) {
      await mobileExchange({ code: `burn-${i}` });
    }
    // Two more requests — both must be 429.
    expect((await mobileExchange()).status).toBe(429);
    expect((await mobileExchange()).status).toBe(429);
  });

  it('returns the correct JSON error shape when blocked', async () => {
    for (let i = 0; i < INVALID_AUTH_MAX_FAILURES; i++) {
      await mobileExchange({ code: `burn-${i}` });
    }
    const res = await mobileExchange();
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toMatchObject({ error: expect.stringContaining('Too many') });
  });
});

// ---------------------------------------------------------------------------
// Cross-instance / rolling-restart: isBlockedShared catches a block that was
// recorded on a *different* limiter instance (same scope) without any local
// recordFailure having been called.
// ---------------------------------------------------------------------------

describe('cross-instance shared budget — rolling-restart safety', () => {
  it('a fresh limiter instance sees the block via isBlockedShared without a preceding recordFailure', async () => {
    const scope = `session-auth-restart-test-${Date.now()}`;
    const opts = { windowMs: 15 * 60 * 1000, max: INVALID_AUTH_MAX_FAILURES, scope };
    const ip = '198.51.100.77';

    // Limiter A: the "previous server instance" — burns the budget into the shared DB.
    const limiterA = createFailureLimiter(opts);
    for (let i = 0; i < INVALID_AUTH_MAX_FAILURES; i++) {
      await limiterA.recordFailure(ip);
    }
    expect(limiterA.isBlocked(ip)).toBe(true);

    // Limiter B: simulates a restarted instance — fresh local cache, same scope.
    const limiterB = createFailureLimiter(opts);

    // Synchronous isBlocked sees nothing: local cache is empty.
    expect(limiterB.isBlocked(ip)).toBe(false);

    // isBlockedShared falls back to the shared DB and must detect the block
    // without any preceding recordFailure call on this instance.
    expect(await limiterB.isBlockedShared(ip)).toBe(true);

    // isBlockedShared hydrates the local cache — synchronous path is now warm.
    expect(limiterB.isBlocked(ip)).toBe(true);

    // A different IP is not affected.
    expect(await limiterB.isBlockedShared('198.51.100.78')).toBe(false);

    limiterA.reset(); // clean up shared DB rows
  });

  it('limiter that has been reset does not block an IP that was only blocked before the reset', async () => {
    const scope = `session-auth-reset-test-${Date.now()}`;
    const opts = { windowMs: 15 * 60 * 1000, max: INVALID_AUTH_MAX_FAILURES, scope };
    const ip = '203.0.113.11';

    const limiter = createFailureLimiter(opts);
    for (let i = 0; i < INVALID_AUTH_MAX_FAILURES; i++) {
      await limiter.recordFailure(ip);
    }
    expect(limiter.isBlocked(ip)).toBe(true);

    limiter.reset();

    // After reset the local cache is cleared and the DB rows are deleted.
    expect(limiter.isBlocked(ip)).toBe(false);
    expect(await limiter.isBlockedShared(ip)).toBe(false);
  });
});
