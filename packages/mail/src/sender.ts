import type { MailTransport, OutboundEmail } from '@michrazon/core';

export interface SendResult {
  sent: boolean;
  messageId?: string;
  skipped?: 'suppressed' | 'dry_run';
}

export interface SenderDeps {
  transport: MailTransport;
  /** Returns true when the address is on the suppression list. */
  isSuppressed: (email: string) => Promise<boolean>;
  /** When true, render+check everything but never hit the transport. */
  dryRun?: boolean;
}

/**
 * Suppression-aware sender (LLD §9): every outbound email is checked against
 * the suppression list before touching the transport. No tracking params or
 * wrappers are ever added — the email goes out exactly as rendered.
 */
export class SuppressionAwareSender {
  constructor(private readonly deps: SenderDeps) {}

  async send(email: OutboundEmail): Promise<SendResult> {
    if (await this.deps.isSuppressed(email.to)) {
      return { sent: false, skipped: 'suppressed' };
    }
    if (this.deps.dryRun) {
      return { sent: false, skipped: 'dry_run' };
    }
    const { messageId } = await this.deps.transport.send(email);
    return { sent: true, messageId };
  }
}

/** Digest headers per LLD §9.2 — RFC 8058 one-click unsubscribe. */
export function digestHeaders(args: {
  unsubscribeUrl: string;
  unsubscribeMailto: string;
}): Record<string, string> {
  return {
    'List-Unsubscribe': `<${args.unsubscribeUrl}>, <mailto:${args.unsubscribeMailto}?subject=unsubscribe>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    'Precedence': 'bulk',
    'Content-Language': 'he',
  };
}

export function confirmHeaders(args: { unsubscribeUrl: string }): Record<string, string> {
  return {
    'List-Unsubscribe': `<${args.unsubscribeUrl}>`,
    'Content-Language': 'he',
  };
}
