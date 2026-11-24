import { z } from 'zod';
import {
  createToken,
  TokenError,
  verifyToken,
  type Db,
  type TokenSecrets,
} from '@michrazon/core';
import type { HandlerRequest, HandlerResult } from './http';
import { html, json } from './http';
import type { RateLimiter } from './rateLimit';

export const CONSENT_TEXT_VERSION = 'v1';

export interface WebDeps {
  db: Db;
  secrets: TokenSecrets;
  baseUrl: string; // e.g. https://michrazon.example — for token URLs in mail
  rateLimiter: RateLimiter;
  sendConfirmEmail: (to: string, confirmUrl: string) => Promise<void>;
  now?: () => number;
}

const emailSchema = z.string().trim().email().max(254);
export const emailNorm = (email: string): string => email.trim().toLowerCase();

/** Uniform subscribe response — never reveals whether an address exists. */
const SUBSCRIBE_OK = { message: 'אם הכתובת קיימת, נשלח מייל אישור.' };

export async function handleSubscribe(req: HandlerRequest, deps: WebDeps): Promise<HandlerResult> {
  const body = req.body ?? {};

  // Honeypot: a filled hidden field means a bot — fake success, no writes.
  if (typeof body['website'] === 'string' && body['website'] !== '') {
    return json(200, SUBSCRIBE_OK);
  }

  if (!deps.rateLimiter.allow(req.clientKey ?? 'anonymous')) {
    return json(200, SUBSCRIBE_OK); // uniform even on limit
  }

  const parsed = emailSchema.safeParse(body['email']);
  if (!parsed.success) return json(200, SUBSCRIBE_OK);
  const norm = emailNorm(parsed.data);

  const suppression = await deps.db.getSuppression(norm);
  // 'complaint' suppressions are never released automatically (AC-20).
  if (suppression?.reason === 'complaint') return json(200, SUBSCRIBE_OK);

  const existing = await deps.db.findSubscriberByEmailNorm(norm);
  if (existing && (existing.status === 'active' || existing.status === 'pending')) {
    return json(200, SUBSCRIBE_OK);
  }

  const sub = await deps.db.createPendingSubscriber({ email: parsed.data });
  await deps.db.appendConsent({
    subscriberId: sub.id,
    event: 'signup_submitted',
    textVersion: CONSENT_TEXT_VERSION,
  });
  const token = createToken({ sub: sub.id, act: 'confirm', secrets: deps.secrets });
  await deps.sendConfirmEmail(parsed.data, `${deps.baseUrl}/confirm?t=${encodeURIComponent(token)}`);
  return json(200, SUBSCRIBE_OK);
}

const tokenSchema = z.string().min(1).max(2048);

function tokenFrom(req: HandlerRequest): string | null {
  const t = req.body?.['t'] ?? req.query?.['t'];
  const parsed = tokenSchema.safeParse(t);
  return parsed.success ? parsed.data : null;
}

const tokenFail = (): HandlerResult => html(400, errorPage('הקישור אינו תקף או שפג תוקפו. אפשר להירשם מחדש בעמוד הראשי.'));

export async function handleConfirm(req: HandlerRequest, deps: WebDeps): Promise<HandlerResult> {
  const token = tokenFrom(req);
  if (!token) return tokenFail();
  let payload;
  try {
    payload = verifyToken(token, deps.secrets, 'confirm', deps.now?.() ?? Date.now());
  } catch (e) {
    if (e instanceof TokenError) return tokenFail();
    throw e;
  }
  const sub = await deps.db.getSubscriberById(payload.sub);
  if (!sub) return tokenFail();
  await deps.db.withTransaction(async (tx) => {
    await tx.confirmSubscriber(sub.id);
    await tx.appendConsent({ subscriberId: sub.id, event: 'confirmed', textVersion: CONSENT_TEXT_VERSION });
  });
  return html(200, okPage('ההרשמה אושרה. הדיגסט היומי יישלח אליך בימים א׳–ה׳.'));
}

export async function handleUnsubscribe(req: HandlerRequest, deps: WebDeps): Promise<HandlerResult> {
  const token = tokenFrom(req);
  if (!token) return tokenFail();
  let payload;
  try {
    payload = verifyToken(token, deps.secrets, 'unsubscribe', deps.now?.() ?? Date.now());
  } catch (e) {
    if (e instanceof TokenError) return tokenFail();
    throw e;
  }
  const sub = await deps.db.getSubscriberById(payload.sub);
  if (!sub) return tokenFail();
  // One transaction: status + suppression + consent (AC-16).
  await deps.db.withTransaction(async (tx) => {
    await tx.updateSubscriberStatus(sub.id, 'unsubscribed');
    await tx.upsertSuppression(sub.email_norm, 'unsubscribe');
    await tx.appendConsent({ subscriberId: sub.id, event: 'unsubscribed', textVersion: CONSENT_TEXT_VERSION });
  });
  return json(200, { message: 'הוסרת מהרשימה.' });
}

export async function handlePrefs(req: HandlerRequest, deps: WebDeps): Promise<HandlerResult> {
  const token = tokenFrom(req);
  if (!token) return tokenFail();
  let payload;
  try {
    payload = verifyToken(token, deps.secrets, 'prefs', deps.now?.() ?? Date.now());
  } catch (e) {
    if (e instanceof TokenError) return tokenFail();
    throw e;
  }
  const sub = await deps.db.getSubscriberById(payload.sub);
  if (!sub) return tokenFail();

  const keywords = Array.isArray(req.body?.['keywords'])
    ? (req.body!['keywords'] as unknown[]).filter((k): k is string => typeof k === 'string').slice(0, 50)
    : [];
  await deps.db.updateSubscriberKeywords(sub.id, keywords);
  return json(200, { message: 'ההעדפות נשמרו.', keywords });
}

// ---------- minimal RTL pages (no third-party scripts, no cookies) ----------

const page = (title: string, inner: string): string => `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;">${inner}</body></html>`;

const okPage = (msg: string): string => page('מכרזון', `<h1>מכרזון</h1><p>${msg}</p>`);
const errorPage = (msg: string): string => page('מכרזון — שגיאה', `<h1>שגיאה</h1><p>${msg}</p>`);

export const landingPage = (): string =>
  page(
    'מכרזון — התראות מכרזים יומיות',
    `<h1>מכרזון</h1>
<p>דיגסט יומי של מכרזים רלוונטיים בתוכנה, דיגיטל ו-AI. שירות פרטי, אינו קשור לגוף ממשלתי.</p>
<form method="post" action="/api/subscribe">
  <label>אימייל <input type="email" name="email" required autocomplete="email"></label>
  <input type="text" name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">
  <button type="submit">הרשמה</button>
</form>`,
  );

export const confirmPage = (token: string): string =>
  page(
    'אישור הרשמה — מכרזון',
    `<h1>אישור הרשמה</h1>
<p>לאישור ההרשמה לדיגסט היומי, לחץ על הכפתור.</p>
<form method="post" action="/api/confirm">
  <input type="hidden" name="t" value="${token}">
  <button type="submit">מאשר/ת</button>
</form>`,
  );

export const unsubscribePage = (token: string): string =>
  page(
    'הסרה — מכרזון',
    `<h1>הסרה מהרשימה</h1>
<p>בטוח להסיר? ההסרה מיידית ובלחיצה אחת.</p>
<form method="post" action="/api/unsubscribe">
  <input type="hidden" name="t" value="${token}">
  <button type="submit">הסר אותי</button>
</form>`,
  );

export const prefsPage = (token: string, keywords: string[]): string =>
  page(
    'העדפות — מכרזון',
    `<h1>העדפות</h1>
<form method="post" action="/api/prefs">
  <input type="hidden" name="t" value="${token}">
  <label>מילות מפתח (מופרדות בפסיקים)
    <input type="text" name="keywords" value="${keywords.join(', ')}">
  </label>
  <button type="submit">שמירה</button>
</form>`,
  );
