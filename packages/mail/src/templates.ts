// Email templates (LLD §9.3-§9.5). Rendered locally — no hosted template,
// no tracking pixel, no external assets, no query params on links.

export const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export interface DigestItemView {
  title: string;
  tender_id: string;
  publisher?: string;
  published?: string;
  deadline?: string;
  summary_he?: string | null;
  official_url: string;
  source_label: string;
}

export interface DigestView {
  date_he: string;
  items: DigestItemView[];
  /** One line per source represented in this digest (attribution duty). */
  attributions: string[];
  unsubscribe_url: string;
  prefs_url: string;
  /** Publisher legal block, e.g. "מכרזון בע״מ · רחוב X · contact@…" (TBD values). */
  publisher_block: string;
}

const AI_DISCLAIMER_HTML =
  'סיכומי AI נוצרים אוטומטית ועלולים להיות שגויים או חלקיים. יש לבדוק תמיד במסמכי המכרז הרשמיים לפני הגשה. מכרזון הוא שירות פרטי ואינו קשור לגוף ממשלתי כלשהו.';
const AI_DISCLAIMER_TEXT =
  'סיכומי AI אוטומטיים ועלולים להיות שגויים. יש לבדוק במסמכי המכרז הרשמיים. שירות פרטי, אינו קשור לגוף ממשלתי.';

const countPhrase = (n: number): string => `${n} מכרזים בתחום תוכנה, דיגיטל ו-AI`;

export function renderDigestHtml(v: DigestView): string {
  const items = v.items
    .map(
      (it) => `    <div style="border-top:1px solid #e5e5e5;padding:12px 0;">
      <div style="font-weight:bold;font-size:16px;">${escapeHtml(it.title)}</div>
      <div style="color:#555;font-size:13px;">מפרסם: ${escapeHtml(it.publisher ?? '—')} · מספר מכרז: ${escapeHtml(it.tender_id)}</div>
      <div style="color:#555;font-size:13px;">פורסם: ${escapeHtml(it.published ?? '—')} · מועד אחרון להגשה: ${escapeHtml(it.deadline ?? '—')}</div>
      ${it.summary_he ? `      <div style="margin-top:6px;font-size:14px;">${escapeHtml(it.summary_he)}</div>\n` : ''}      <div style="margin-top:6px;font-size:13px;">
        <a href="${escapeHtml(it.official_url)}">למקור הרשמי</a>
      </div>
      <div style="color:#777;font-size:12px;">מקור: ${escapeHtml(it.source_label)}</div>
    </div>`,
    )
    .join('\n');
  const attributions = v.attributions.map(escapeHtml).join('<br>');
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>מכרזון — ${escapeHtml(v.date_he)}</title>
</head>
<body style="margin:0;padding:0;background:#f6f6f6;direction:rtl;text-align:right;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;padding:20px;" dir="rtl">
    <h1 style="font-size:20px;margin:0 0 4px;">מכרזים חדשים — ${escapeHtml(v.date_he)}</h1>
    <p style="margin:0 0 16px;color:#555;">${countPhrase(v.items.length)}</p>

${items}

    <p style="color:#777;font-size:12px;border-top:1px solid #e5e5e5;padding-top:12px;">
      ${AI_DISCLAIMER_HTML}
    </p>
    <p style="color:#777;font-size:12px;">${attributions}</p>
    <p style="color:#777;font-size:12px;">
      <a href="${escapeHtml(v.unsubscribe_url)}">הסרה מהרשימה בלחיצה אחת</a> · <a href="${escapeHtml(v.prefs_url)}">העדפות</a><br>
      ${escapeHtml(v.publisher_block)}
    </p>
  </div>
</body>
</html>`;
}

export function renderDigestText(v: DigestView): string {
  const items = v.items
    .map(
      (it, i) => `${i + 1}) ${it.title}
   מפרסם: ${it.publisher ?? '—'} | מספר מכרז: ${it.tender_id}
   פורסם: ${it.published ?? '—'} | מועד אחרון להגשה: ${it.deadline ?? '—'}
${it.summary_he ? `   סיכום: ${it.summary_he}\n` : ''}   מקור רשמי: ${it.official_url}`,
    )
    .join('\n\n');
  return `מכרזון — מכרזים חדשים, ${v.date_he}
${countPhrase(v.items.length)}

${items}

${AI_DISCLAIMER_TEXT}
${v.attributions.join('\n')}
הסרה בלחיצה אחת: ${v.unsubscribe_url}
העדפות: ${v.prefs_url}
${v.publisher_block}`;
}

export function digestSubject(n: number, dateHe: string): string {
  return `מכרזון | ${n} מכרזים חדשים בתוכנה, דיגיטל ו-AI — ${dateHe}`;
}

// ---------- double opt-in confirmation (LLD §9.5) ----------

export interface ConfirmView {
  confirm_url: string;
}

export const CONFIRM_SUBJECT = 'אישור הרשמה למכרזון';

export function renderConfirmHtml(v: ConfirmView): string {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head><meta charset="utf-8"><title>${CONFIRM_SUBJECT}</title></head>
<body style="margin:0;padding:0;background:#f6f6f6;direction:rtl;text-align:right;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;padding:20px;" dir="rtl">
    <p>היי, קיבלנו בקשת הרשמה לדיגסט היומי של מכרזון — מכרזים רלוונטיים בתוכנה, דיגיטל ו-AI, פעם ביום.</p>
    <p><a href="${escapeHtml(v.confirm_url)}" style="display:inline-block;background:#1a56db;color:#ffffff;padding:10px 18px;text-decoration:none;border-radius:6px;">לאישור ההרשמה</a></p>
    <p style="color:#777;font-size:12px;">אם לא ביקשת — התעלם, לא יישלח דבר נוסף.</p>
  </div>
</body>
</html>`;
}

export function renderConfirmText(v: ConfirmView): string {
  return `אישור הרשמה למכרזון

קיבלנו בקשת הרשמה לדיגסט היומי של מכרזון — מכרזים רלוונטיים בתוכנה, דיגיטל ו-AI, פעם ביום.
לאישור: ${v.confirm_url}
אם לא ביקשת — התעלם, לא יישלח דבר נוסף.`;
}

// ---------- zero-tracking guard ----------

const TRACKING_PATTERNS = [
  /utm_[a-z]+=/i,
  /<img\b/i,
  /tracking/i,
  /pixel/i,
  /beacon/i,
  /open\.(gif|png|jpg)/i,
  /clicktrack/i,
];

/** Throws if rendered mail contains anything resembling tracking. CI uses this. */
export function assertNoTracking(rendered: string): void {
  for (const re of TRACKING_PATTERNS) {
    const m = re.exec(rendered);
    if (m) throw new Error(`tracking pattern detected in email output: ${m[0]}`);
  }
}
