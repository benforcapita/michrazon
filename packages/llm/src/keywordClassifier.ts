import type { ClassificationOutcome } from './classifier.ts';
import type { ClassificationInput, ClassificationResult } from './schema.ts';
import type { TenderClassifier } from './tenderClassifier.ts';

// Keyword-only fallback (PRO-812 §4): deterministic relevance signals for
// when Jev is unreachable. Conservative — ambiguous or signal-free tenders
// come back uncertain=true, which keeps them out of the digest.

const RELEVANT_KEYWORDS = [
  'תוכנה',
  'מערכת מידע',
  'מערכות מידע',
  'אפליקצי',
  'אתר אינטרנט',
  'אתרי אינטרנט',
  'פורטל',
  'ענן',
  'אבטחת מידע',
  'סייבר',
  'בינה מלאכותית',
  'למידת מכונה',
  'אוטומצי',
  'דיגיטל',
  'שיווק דיגיטלי',
  'מחשוב',
  'הטמעת מערכות',
  'נתונים',
  'דשבורד',
  'software',
  'devops',
  'cloud',
  'cyber',
  'machine learning',
  'crm',
  'erp',
  'dashboard',
] as const;

const IRRELEVANT_KEYWORDS = [
  'חומרה',
  'בנייה',
  'בניה',
  'ציוד משרדי',
  'כוח אדם',
  'ריהוט',
  'ניקיון',
  'מזון',
  'קייטרינג',
  'הובלה',
  'דלק',
  'מדים',
  'גינון',
  'שמירה',
  'מיזוג אוויר',
  'דפוס',
  'hardware',
  'construction',
  'cleaning',
  'catering',
  'staffing',
] as const;

function haystack(input: ClassificationInput): string {
  const parts: string[] = [input.title];
  if (input.publisher) parts.push(input.publisher);
  if (input.source_tier === 'green' && input.open_data_fields) {
    for (const v of Object.values(input.open_data_fields)) {
      if (typeof v === 'string') parts.push(v);
    }
  }
  return parts.join('\n').toLowerCase();
}

const hits = (text: string, keywords: readonly string[]): number =>
  keywords.reduce((n, k) => n + (text.includes(k.toLowerCase()) ? 1 : 0), 0);

export class KeywordClassifier implements TenderClassifier {
  readonly id = 'keyword';

  classify(input: ClassificationInput): Promise<ClassificationOutcome> {
    const text = haystack(input);
    const relevantHits = hits(text, RELEVANT_KEYWORDS);
    const irrelevantHits = hits(text, IRRELEVANT_KEYWORDS);

    let result: ClassificationResult;
    if (relevantHits > 0 && irrelevantHits === 0) {
      result = {
        is_relevant: true,
        confidence: 0.6,
        category: 'it_services',
        summary_he: null,
        facts_used: ['title'],
        uncertain: false,
      };
    } else if (irrelevantHits > 0 && relevantHits === 0) {
      result = {
        is_relevant: false,
        confidence: 0.6,
        category: 'other_not_relevant',
        summary_he: null,
        facts_used: ['title'],
        uncertain: false,
      };
    } else {
      // Both or neither signal — conservative: uncertain keeps it out of
      // the digest and flags it for the next Jev run.
      result = {
        is_relevant: false,
        confidence: 0.3,
        category: 'other_not_relevant',
        summary_he: null,
        facts_used: ['title'],
        uncertain: true,
      };
    }

    return Promise.resolve({
      status: 'ok',
      result,
      attempts: 1,
      inputTokens: 0,
      outputTokens: 0,
      modelId: this.id,
    });
  }
}
