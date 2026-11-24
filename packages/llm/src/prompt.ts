import type { ClassificationInput } from './schema';

// Prompt v1 (LLD §8.2). Version is stamped on tender_classifications rows so
// a prompt change produces a new input_hash and reclassifies cleanly.
export const PROMPT_VERSION = 'v1';

export const SYSTEM_PROMPT = [
  'אתה מסווג מכרזים ציבוריים בישראל עבור ספקי תוכנה, דיגיטל ו-AI (בתי תוכנה קטנים, סוכנויות, פרילנסרים).',
  'קיבלת אך ורק את העובדות שבקלט. אל תניח דבר מעבר להן. אל תמציא מספרים, תאריכים, סכומים או תנאים.',
  'אם העובדות אינן מספיקות כדי לקבוע רלוונטיות, החזר is_relevant=false או uncertain=true.',
  'כתוב summary_he בעברית פשוטה, משפט אחד או שניים, עד 280 תווים, בלי שיווק ובלי הבטחות.',
  'החזר JSON בלבד התואם לסכמה. ללא טקסט נוסף.',
  'רלוונטי: פיתוח תוכנה, אתרים ואפליקציות, תשתיות ענן ו-DevOps, אבטחת מידע דיגיטלית, נתונים ו-BI, AI/ML ואוטומציה, UX/UI ושיווק דיגיטלי, שירותי IT והטמעת מערכות.',
  'לא רלוונטי: חומרה בלבד, בנייה, ציוד משרדי, שירותי כוח אדם כלליים.',
].join('\n');

/** Short correction message appended for the single retry (LLD §8.4.1). */
export const RETRY_HINT =
  'התשובה הקודמת לא עברה אימות סכמה או בדיקת עובדות. החזר JSON תקין בלבד, בלי שדות נוספים, ובלי מידע שלא הופיע בקלט.';

/**
 * Build the user message: a JSON object of facts only. For yellow sources
 * open_data_fields is dropped — a typed safeguard against leaking page text.
 */
export function buildUserPrompt(input: ClassificationInput): string {
  const facts: Record<string, unknown> = {
    source_tier: input.source_tier,
    title: input.title,
  };
  if (input.publisher) facts['publisher'] = input.publisher;
  if (input.published_at) facts['published_at'] = input.published_at;
  if (input.submission_deadline) facts['submission_deadline'] = input.submission_deadline;
  if (input.source_tier === 'green' && input.open_data_fields) {
    facts['open_data_fields'] = input.open_data_fields;
  }
  return JSON.stringify(facts);
}
