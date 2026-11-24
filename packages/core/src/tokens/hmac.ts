// HMAC-signed action tokens (LLD §14): t = base64url(payload) + '.' +
// base64url(HMAC-SHA256(secret, payload)). Constant-time verification, `act`
// checked per route, key rotation via `kid`. No PII beyond subscriber UUID.
import { createHmac, timingSafeEqual } from 'node:crypto';

export type TokenAction = 'confirm' | 'unsubscribe' | 'prefs';

export const TOKEN_TTL_MS: Record<TokenAction, number | null> = {
  confirm: 48 * 60 * 60 * 1000, // 48 hours
  prefs: 30 * 24 * 60 * 60 * 1000, // 30 days
  unsubscribe: null, // never expires — must always work
};

export interface TokenPayload {
  sub: string; // subscriber UUID
  act: TokenAction;
  exp: number | null; // epoch ms; null = no expiry (unsubscribe)
  kid: string; // key id for rotation
}

export class TokenError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | 'malformed'
      | 'bad_signature'
      | 'wrong_action'
      | 'expired'
      | 'unknown_key',
  ) {
    super(message);
    this.name = 'TokenError';
  }
}

/** kid -> secret. Verification picks the secret by the token's kid. */
export type TokenSecrets = Record<string, string>;

function base64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function sign(payloadB64: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

export function createToken(input: {
  sub: string;
  act: TokenAction;
  secrets: TokenSecrets;
  kid?: string;
  now?: number;
}): string {
  const kid = input.kid ?? Object.keys(input.secrets)[0];
  if (!kid || !(kid in input.secrets)) throw new TokenError('unknown key id', 'unknown_key');
  const ttl = TOKEN_TTL_MS[input.act];
  const now = input.now ?? Date.now();
  const payload: TokenPayload = {
    sub: input.sub,
    act: input.act,
    exp: ttl === null ? null : now + ttl,
    kid,
  };
  const payloadB64 = base64url(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64, input.secrets[kid]!)}`;
}

export function verifyToken(
  token: string,
  secrets: TokenSecrets,
  expectedAct: TokenAction,
  now: number = Date.now(),
): TokenPayload {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) throw new TokenError('malformed token', 'malformed');
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as TokenPayload;
  } catch {
    throw new TokenError('malformed token payload', 'malformed');
  }
  if (typeof payload.sub !== 'string' || typeof payload.act !== 'string' || !payload.kid) {
    throw new TokenError('malformed token payload', 'malformed');
  }

  const secret = secrets[payload.kid];
  if (!secret) throw new TokenError('unknown key id', 'unknown_key');

  const expected = sign(payloadB64, secret);
  const a = Buffer.from(sigB64);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new TokenError('bad signature', 'bad_signature');
  }

  if (payload.act !== expectedAct) throw new TokenError('wrong action', 'wrong_action');
  if (payload.exp !== null && now > payload.exp) throw new TokenError('token expired', 'expired');
  return payload;
}
