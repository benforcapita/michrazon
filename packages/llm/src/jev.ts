import { z } from 'zod';
import { postCheck, type ClassificationOutcome } from './classifier.ts';
import { buildUserPrompt } from './prompt.ts';
import type { ClassificationInput, ClassificationResult } from './schema.ts';
import { CATEGORY_ENUM, classificationResultSchema } from './schema.ts';
import type { TenderClassifier } from './tenderClassifier.ts';

// TypeSafe Jev classifier (PRO-812): System One `Choice` questions over the
// tender facts — not a chat-completions call. Uses the documented HTTP API
// (POST {baseUrl}/v1/systemone); no SDK dependency, fetch is injected so
// tests never touch the network.

export const DEFAULT_JEV_MIN_CONFIDENCE = 0.55;
/** JEV_TIMEOUT_MS default (PRO-818): a hung TypeSafe call must not block the tick. */
export const DEFAULT_JEV_TIMEOUT_MS = 15_000;
export const TYPESAFE_DEFAULT_BASE_URL = 'https://api.typesafe.ai';

export interface JevSystemOneRequest {
  state: unknown;
  model?: string;
  questions: Record<string, unknown>;
}

/** The injectable client seam — tests pass a mock; prod uses the HTTP client. */
export type JevSystemOne = (req: JevSystemOneRequest) => Promise<unknown>;

export type JevFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface JevHttpClientOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  fetchImpl: JevFetch;
  timeoutMs?: number;
}

/** Real client. Missing TYPESAFE_API_KEY throws on call — the caller's
 *  fallback handles it; the worker must not fail at construction. The call
 *  is bounded by timeoutMs two ways: the AbortSignal is forwarded to fetch,
 *  and an explicit race rejects even if a fetch impl ignores the signal. */
export function createJevSystemOneClient(opts: JevHttpClientOptions): JevSystemOne {
  const baseUrl = opts.baseUrl ?? TYPESAFE_DEFAULT_BASE_URL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS;
  return async (req) => {
    if (!opts.apiKey) throw new Error('TYPESAFE_API_KEY is not set');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`typesafe request timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    const res = await Promise.race([
      opts.fetchImpl(`${baseUrl}/v1/systemone`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...req, model: req.model ?? opts.model }),
        signal: AbortSignal.timeout(timeoutMs),
      }),
      timedOut,
    ]).finally(() => clearTimeout(timer));
    const body = (await res.json()) as { error?: { message?: string } | string };
    if (res.status >= 400) {
      const msg = typeof body.error === 'string' ? body.error : (body.error?.message ?? 'unknown');
      throw new Error(`typesafe api error (${res.status}): ${msg}`);
    }
    return body;
  };
}

// Relevance + category criteria mirror SYSTEM_PROMPT's domain definition.
const RELEVANCE_INSTRUCTIONS =
  'האם המכרז רלוונטי לספקי תוכנה, דיגיטל ו-AI (בתי תוכנה קטנים, סוכנויות, פרילנסרים)?';

const RELEVANCE_CRITERIA = {
  relevant:
    'פיתוח תוכנה, אתרים ואפליקציות, תשתיות ענן ו-DevOps, אבטחת מידע דיגיטלית, נתונים ו-BI, AI/ML ואוטומציה, UX/UI ושיווק דיגיטלי, שירותי IT והטמעת מערכות',
  not_relevant: 'חומרה בלבד, בנייה, ציוד משרדי, שירותי כוח אדם כלליים, או כל מכרז אחר מחוץ לתחום',
} as const;

const CATEGORY_INSTRUCTIONS = 'מהי הקטגוריה המתאימה ביותר למכרז?';

const CATEGORY_CRITERIA: Record<(typeof CATEGORY_ENUM)[number], string> = {
  software_dev: 'פיתוח תוכנה, מערכות מידע, התאמות ופיתוח מודולים',
  web_mobile: 'אתרים, פורטלים ואפליקציות מובייל',
  cloud_devops: 'תשתיות ענן, DevOps, שרתים ותשתיות IT',
  security: 'אבטחת מידע דיגיטלית וסייבר',
  data_bi: 'נתונים, BI, ETL, דשבורדים ואנליטיקה',
  ai_ml_automation: 'בינה מלאכותית, למידת מכונה, NLP ואוטומציה של תהליכים',
  ux_marketing_digital: 'UX/UI, עיצוב, שיווק דיגיטלי ותוכן',
  it_services: 'שירותי IT, הטמעת מערכות, רישוי תוכנה ותמיכה טכנית',
  other_not_relevant: 'כל שאר — מכרזים מחוץ לתחומי התוכנה והדיגיטל',
};

export function buildJevQuestions(): Record<string, unknown> {
  return {
    relevance: {
      type: 'choice',
      instructions: RELEVANCE_INSTRUCTIONS,
      criteria: RELEVANCE_CRITERIA,
    },
    category: {
      type: 'choice',
      instructions: CATEGORY_INSTRUCTIONS,
      criteria: CATEGORY_CRITERIA,
    },
  };
}

const choiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number()).optional(),
});

const systemOneResponseSchema = z.object({
  model: z.string().optional(),
  answers: z.record(z.string(), z.unknown()),
  usage: z
    .object({ input_tokens: z.number().optional(), output_tokens: z.number().optional() })
    .optional(),
});

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

function factsUsed(input: ClassificationInput): ClassificationResult['facts_used'] {
  const used: ClassificationResult['facts_used'] = ['title'];
  if (input.publisher) used.push('publisher');
  if (input.published_at) used.push('published_at');
  if (input.submission_deadline) used.push('submission_deadline');
  if (input.source_tier === 'green' && input.open_data_fields) used.push('open_data_fields');
  return used;
}

export interface JevClassifierOptions {
  systemOne: JevSystemOne;
  /** Digest gate for the jev path — JEV_MIN_CONFIDENCE (default 0.55). */
  minConfidence?: number;
  model?: string;
  id?: string;
}

export class JevClassifier implements TenderClassifier {
  readonly id: string;
  private readonly minConfidence: number;

  constructor(private readonly opts: JevClassifierOptions) {
    this.id = opts.id ?? 'jev';
    this.minConfidence = opts.minConfidence ?? DEFAULT_JEV_MIN_CONFIDENCE;
  }

  async classify(input: ClassificationInput): Promise<ClassificationOutcome> {
    // State carries facts only — buildUserPrompt already drops
    // open_data_fields for yellow sources, so page text can't reach Jev.
    const state = JSON.parse(buildUserPrompt(input)) as unknown;
    const raw = await this.opts.systemOne({
      state,
      model: this.opts.model,
      questions: buildJevQuestions(),
    });
    const body = systemOneResponseSchema.parse(raw);

    const relevance = choiceAnswerSchema.parse(body.answers['relevance']);
    const knownChoice = relevance.choice === 'relevant' || relevance.choice === 'not_relevant';
    const isRelevant = relevance.choice === 'relevant';
    const confidence = clamp01(relevance.confidence);

    let category: ClassificationResult['category'] = 'other_not_relevant';
    if (isRelevant) {
      const cat = choiceAnswerSchema.safeParse(body.answers['category']);
      if (cat.success && (CATEGORY_ENUM as readonly string[]).includes(cat.data.choice)) {
        category = cat.data.choice as ClassificationResult['category'];
      }
    }

    const result = classificationResultSchema.parse({
      is_relevant: isRelevant,
      confidence,
      category,
      summary_he: null, // pilot: no LLM summaries (PRO-812)
      facts_used: factsUsed(input),
      uncertain: !knownChoice || confidence < this.minConfidence,
    });

    const violation = postCheck(result, input, JSON.stringify(state));
    return {
      status: violation === null ? 'ok' : 'needs_review',
      result: violation === null ? result : undefined,
      reason: violation,
      attempts: 1,
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
      modelId: body.model ?? this.opts.model ?? this.id,
    };
  }
}
