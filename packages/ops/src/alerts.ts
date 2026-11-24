import type { MailTransport, OutboundEmail } from '@michrazon/core';

// Ops alerts (LLD §13): every alert path funnels through AlertSink so tests
// capture alerts without a transport. The email sink is a plain text-only
// message to the ops address — no tracking, no HTML.

export interface Alert {
  subject: string;
  body: string;
  severity: 'warn' | 'critical';
}

export interface AlertSink {
  send(alert: Alert): Promise<void>;
}

export class EmailAlertSink implements AlertSink {
  constructor(
    private readonly transport: MailTransport,
    private readonly to: string,
    private readonly from: string,
  ) {}

  async send(alert: Alert): Promise<void> {
    const email: OutboundEmail = {
      to: this.to,
      subject: `[michrazon:${alert.severity}] ${alert.subject}`,
      html: `<pre>${alert.body.replace(/</g, '&lt;')}</pre>`,
      text: alert.body,
      headers: { 'Content-Language': 'he' },
    };
    await this.transport.send(email);
  }
}

/** Collects alerts in memory — tests and dry-run mode. */
export class MemoryAlertSink implements AlertSink {
  readonly alerts: Alert[] = [];
  async send(alert: Alert): Promise<void> {
    this.alerts.push(alert);
  }
}
