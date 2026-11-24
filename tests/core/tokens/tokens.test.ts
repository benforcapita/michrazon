import { describe, expect, it } from 'vitest';
import { createToken, TokenError, verifyToken, type TokenSecrets } from '@michrazon/core';

const SECRETS: TokenSecrets = { k1: 'test-secret-key-1' };
const ROTATED: TokenSecrets = { k1: 'test-secret-key-1', k2: 'test-secret-key-2' };

const SUB = '3f6f9b30-9d0b-4f56-9b8a-0d7f0b2d1c2d';

describe('HMAC tokens (AC-14)', () => {
  it('round-trips a valid confirm token', () => {
    const t = createToken({ sub: SUB, act: 'confirm', secrets: SECRETS, kid: 'k1' });
    const payload = verifyToken(t, SECRETS, 'confirm');
    expect(payload.sub).toBe(SUB);
    expect(payload.act).toBe('confirm');
    expect(payload.kid).toBe('k1');
  });

  it('expired confirm token fails', () => {
    const now = Date.now();
    const t = createToken({ sub: SUB, act: 'confirm', secrets: SECRETS, kid: 'k1', now });
    const in49h = now + 49 * 60 * 60 * 1000;
    expect(() => verifyToken(t, SECRETS, 'confirm', in49h)).toThrow(TokenError);
    const in47h = now + 47 * 60 * 60 * 1000;
    expect(verifyToken(t, SECRETS, 'confirm', in47h).sub).toBe(SUB);
  });

  it('wrong act is rejected (unsubscribe token cannot confirm)', () => {
    const t = createToken({ sub: SUB, act: 'unsubscribe', secrets: SECRETS, kid: 'k1' });
    try {
      verifyToken(t, SECRETS, 'confirm');
      expect.unreachable();
    } catch (e) {
      expect((e as TokenError).reason).toBe('wrong_action');
    }
  });

  it('unsubscribe tokens never expire', () => {
    const now = Date.now();
    const t = createToken({ sub: SUB, act: 'unsubscribe', secrets: SECRETS, kid: 'k1', now });
    const farFuture = now + 100 * 365 * 24 * 60 * 60 * 1000;
    expect(verifyToken(t, SECRETS, 'unsubscribe', farFuture).sub).toBe(SUB);
  });

  it('forged and truncated tokens fail', () => {
    const t = createToken({ sub: SUB, act: 'prefs', secrets: SECRETS, kid: 'k1' });
    const [p] = t.split('.');
    expect(() => verifyToken(`${p}.AAAA`, SECRETS, 'prefs')).toThrow(TokenError);
    expect(() => verifyToken(t.slice(0, -5), SECRETS, 'prefs')).toThrow(TokenError);
    expect(() => verifyToken('garbage', SECRETS, 'prefs')).toThrow(TokenError);
    // payload tampering
    const tampered = `${Buffer.from(JSON.stringify({ sub: SUB, act: 'prefs', exp: null, kid: 'k1' })).toString('base64url')}.${t.split('.')[1]}`;
    expect(() => verifyToken(tampered, SECRETS, 'prefs')).toThrow(TokenError);
  });

  it('key rotation via kid: old tokens verify under the old key', () => {
    const old = createToken({ sub: SUB, act: 'confirm', secrets: SECRETS, kid: 'k1' });
    const next = createToken({ sub: SUB, act: 'confirm', secrets: ROTATED, kid: 'k2' });
    expect(verifyToken(old, ROTATED, 'confirm').kid).toBe('k1');
    expect(verifyToken(next, ROTATED, 'confirm').kid).toBe('k2');
    // unknown kid is rejected
    expect(() => verifyToken(old, { k9: 'x' }, 'confirm')).toThrow(TokenError);
  });
});
