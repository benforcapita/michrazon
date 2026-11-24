import { describe, expect, it } from 'vitest';
import type { OutboundEmail } from '@michrazon/core';
import {
  assertNoTracking,
  assertTrackingOff,
  CONFIRM_SUBJECT,
  digestHeaders,
  digestSubject,
  renderConfirmHtml,
  renderConfirmText,
  renderDigestHtml,
  renderDigestText,
  ResendTransport,
  SuppressionAwareSender,
  type DigestView,
} from '@michrazon/mail';

const VIEW: DigestView = {
  date_he: '15.01.2026',
  items: [
    {
      title: 'פיתוח מערכת <script>alert(1)</script>',
      tender_id: '55/2026',
      publisher: 'עיריית באר שבע',
      published: '12.01.2026',
      deadline: '30.01.2026',
      summary_he: 'מכרז לפיתוח מערכת ניהול תשתיות.',
      official_url: 'https://data.gov.il/dataset/tenders-beersheva',
      source_label: 'data.gov.il (נתונים פתוחים)',
    },
  ],
  attributions: ['נתונים מאתר data.gov.il, רישיון נתונים פתוחים'],
  unsubscribe_url: 'https://michrazon.example/api/unsubscribe?t=TOK',
  prefs_url: 'https://michrazon.example/prefs?t=TOK',
  publisher_block: 'מכרזון · contact@example.com',
};

describe('digest templates', () => {
  it('renders RTL HTML with direct source links and no tracking (AC-10)', () => {
    const html = renderDigestHtml(VIEW);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('למקור הרשמי');
    expect(html).toContain('href="https://data.gov.il/dataset/tenders-beersheva"');
    expect(html).toContain('הסרה מהרשימה בלחיצה אחת');
    expect(assertNoTracking(html)).toBeUndefined();
    expect(assertNoTracking(renderDigestText(VIEW))).toBeUndefined();
  });

  it('escapes HTML in interpolated fields', () => {
    const html = renderDigestHtml(VIEW);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('includes the fixed AI disclaimer (not LLM-generated)', () => {
    expect(renderDigestHtml(VIEW)).toContain('סיכומי AI נוצרים אוטומטית');
    expect(renderDigestText(VIEW)).toContain('סיכומי AI אוטומטיים');
  });

  it('subject follows the LLD format', () => {
    expect(digestSubject(3, '15.01.2026')).toBe('מכרזון | 3 מכרזים חדשים בתוכנה, דיגיטל ו-AI — 15.01.2026');
  });
});

describe('headers (RFC 8058)', () => {
  it('digest headers carry one-click unsubscribe', () => {
    const h = digestHeaders({
      unsubscribeUrl: 'https://michrazon.example/api/unsubscribe?t=T',
      unsubscribeMailto: 'unsubscribe@example.com',
    });
    expect(h['List-Unsubscribe']).toContain('https://michrazon.example/api/unsubscribe?t=T');
    expect(h['List-Unsubscribe']).toContain('mailto:unsubscribe@example.com');
    expect(h['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(h['Content-Language']).toBe('he');
  });
});

describe('confirmation email (double opt-in)', () => {
  it('has the expected subject and a single confirm link', () => {
    expect(CONFIRM_SUBJECT).toBe('אישור הרשמה למכרזון');
    const html = renderConfirmHtml({ confirm_url: 'https://x.example/c?t=TOK' });
    expect(html).toContain('לאישור ההרשמה');
    expect(html).toContain('אם לא ביקשת');
    expect(assertNoTracking(html)).toBeUndefined();
    expect(renderConfirmText({ confirm_url: 'https://x.example/c?t=TOK' })).toContain('https://x.example/c?t=TOK');
  });
});

describe('SuppressionAwareSender', () => {
  const email: OutboundEmail = {
    to: 'a@b.com',
    subject: 's',
    html: '<p>h</p>',
    text: 't',
    headers: {},
  };

  it('skips suppressed addresses without touching the transport', async () => {
    let transportCalls = 0;
    const sender = new SuppressionAwareSender({
      transport: { send: async () => { transportCalls += 1; return { messageId: 'x' }; } },
      isSuppressed: async () => true,
    });
    const res = await sender.send(email);
    expect(res).toEqual({ sent: false, skipped: 'suppressed' });
    expect(transportCalls).toBe(0);
  });

  it('dry-run renders but never sends', async () => {
    let transportCalls = 0;
    const sender = new SuppressionAwareSender({
      transport: { send: async () => { transportCalls += 1; return { messageId: 'x' }; } },
      isSuppressed: async () => false,
      dryRun: true,
    });
    expect(await sender.send(email)).toEqual({ sent: false, skipped: 'dry_run' });
    expect(transportCalls).toBe(0);
  });

  it('sends when not suppressed', async () => {
    const sender = new SuppressionAwareSender({
      transport: { send: async () => ({ messageId: 'msg-1' }) },
      isSuppressed: async () => false,
    });
    expect(await sender.send(email)).toEqual({ sent: true, messageId: 'msg-1' });
  });
});

describe('ResendTransport + tracking check', () => {
  it('posts the email with headers to the Resend API', async () => {
    let seen: { url: string; body: Record<string, unknown> } | undefined;
    const transport = new ResendTransport({
      apiKey: 'k',
      from: 'מכרזון <alerts@example.com>',
      fetchImpl: async (url, init) => {
        seen = { url, body: JSON.parse(init.body ?? '{}') };
        return { status: 200, json: async () => ({ id: 're_1' }) };
      },
    });
    const { messageId } = await transport.send({
      to: 'a@b.com',
      subject: 's',
      html: '<p>x</p>',
      text: 'x',
      headers: { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    });
    expect(messageId).toBe('re_1');
    expect(seen?.url).toBe('https://api.resend.com/emails');
    expect(seen?.body['headers']).toMatchObject({ 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
  });

  it('assertTrackingOff fails when tracking is enabled or unverifiable', () => {
    expect(() =>
      assertTrackingOff({ trackingOff: false, verified: true, raw: {} }),
    ).toThrow(/tracking enabled/);
    expect(() =>
      assertTrackingOff({ trackingOff: false, verified: false, raw: {} }),
    ).toThrow(/failing closed/);
    expect(assertTrackingOff({ trackingOff: true, verified: true, raw: {} })).toBeUndefined();
  });
});
