import type { MailTransport, OutboundEmail } from '@michrazon/core';

// Resend transport (LLD §9.1). The fetch impl is injected so tests never hit
// the network. Open/click tracking must be OFF at the domain level — see
// assertTrackingOff for the deploy-time check.

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface ResendTransportDeps {
  apiKey: string;
  from: string;
  replyTo?: string;
  fetchImpl: FetchLike;
  baseUrl?: string;
}

export class ResendTransport implements MailTransport {
  private readonly baseUrl: string;

  constructor(private readonly deps: ResendTransportDeps) {
    this.baseUrl = deps.baseUrl ?? 'https://api.resend.com';
  }

  async send(email: OutboundEmail): Promise<{ messageId: string }> {
    const res = await this.deps.fetchImpl(`${this.baseUrl}/emails`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.deps.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.deps.from,
        to: [email.to],
        subject: email.subject,
        html: email.html,
        text: email.text,
        reply_to: this.deps.replyTo,
        headers: email.headers,
      }),
    });
    const body = (await res.json()) as { id?: string; message?: string };
    if (res.status >= 400 || !body.id) {
      throw new Error(`resend send failed (${res.status}): ${body.message ?? 'unknown'}`);
    }
    return { messageId: body.id };
  }
}

export interface DomainTrackingStatus {
  /** true = verified both off; false = at least one enabled. */
  trackingOff: boolean;
  /** false when the API didn't expose the flags (TBD per LLD §9.1). */
  verified: boolean;
  raw: unknown;
}

/**
 * Deploy-time verification (LLD §9.1): fetch the sending domain's tracking
 * settings and fail if click/open tracking is enabled. When the API can't
 * confirm the flags, verified=false — the caller decides whether to fail
 * the deploy (recommended: fail closed in CI).
 */
export async function checkDomainTracking(
  deps: { apiKey: string; domainId: string; fetchImpl: FetchLike; baseUrl?: string },
): Promise<DomainTrackingStatus> {
  const res = await deps.fetchImpl(
    `${deps.baseUrl ?? 'https://api.resend.com'}/domains/${deps.domainId}`,
    { method: 'GET', headers: { Authorization: `Bearer ${deps.apiKey}` } },
  );
  const body = (await res.json()) as Record<string, unknown>;
  if (res.status >= 400) return { trackingOff: false, verified: false, raw: body };
  const open = body['open_tracking'] ?? body['openTracking'];
  const click = body['click_tracking'] ?? body['clickTracking'];
  if (typeof open !== 'boolean' && typeof click !== 'boolean') {
    return { trackingOff: false, verified: false, raw: body };
  }
  return { trackingOff: open === false && click === false, verified: true, raw: body };
}

export function assertTrackingOff(status: DomainTrackingStatus): void {
  if (!status.verified) {
    throw new Error('cannot verify Resend domain tracking settings — failing closed');
  }
  if (!status.trackingOff) {
    throw new Error('Resend domain has open/click tracking enabled — disable before deploy');
  }
}
