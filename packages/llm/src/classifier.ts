import type { LlmProvider } from '@michrazon/core';
import { buildUserPrompt, RETRY_HINT, SYSTEM_PROMPT } from './prompt';
import type { ClassificationInput, ClassificationResult } from './schema';
import { classificationResultSchema, CLASSIFICATION_JSON_SCHEMA } from './schema';

export type ClassificationStatus = 'ok' | 'needs_review';

export interface ClassificationOutcome {
  status: ClassificationStatus;
  result?: ClassificationResult;
  reason?: string | null;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  modelId?: string;
}

export interface ClassifyOptions {
  maxOutputTokens?: number;
  timeoutMs?: number;
  temperature?: number;
}

// Words that must never appear in a yellow-source summary (LLD §8.4.4):
// threshold terms are booklet-derived and would be ungrounded claims.
export const YELLOW_FORBIDDEN_WORDS = ['ערבות', 'תנאי סף', 'היקף'] as const;

const numberTokens = (s: string): string[] => s.match(/\d[\d,./-]*\d|\d/g) ?? [];

const stripCodeFence = (s: string): string =>
  s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

/** Every digit/date token in the summary must appear in the input facts. */
function summaryNumbersGrounded(summary: string, inputFactsJson: string): boolean {
  const haystack = inputFactsJson.replace(/\s+/g, '');
  return numberTokens(summary).every((tok) => {
    const variants = [tok, tok.replace(/,/g, ''), tok.replace(/-/g, '/'), tok.replace(/\//g, '-')];
    return variants.some((v) => haystack.includes(v));
  });
}

export function postCheck(
  result: ClassificationResult,
  input: ClassificationInput,
  inputFactsJson: string,
): string | null {
  if (!result.is_relevant && result.summary_he !== null) {
    return 'is_relevant=false requires summary_he=null';
  }
  if (result.is_relevant && result.summary_he !== null) {
    if (!summaryNumbersGrounded(result.summary_he, inputFactsJson)) {
      return 'summary_he contains numbers/dates not present in the input facts';
    }
  }
  if (input.source_tier === 'yellow') {
    if (result.facts_used.includes('open_data_fields')) {
      return 'yellow source: facts_used may not include open_data_fields';
    }
    const summary = result.summary_he ?? '';
    for (const word of YELLOW_FORBIDDEN_WORDS) {
      if (summary.includes(word)) {
        return `yellow source: forbidden threshold term '${word}' in summary`;
      }
    }
  }
  return null;
}

/**
 * Classify one tender through the injected provider (LLD §8.4):
 * parse -> zod -> post-check; on any failure one retry with RETRY_HINT,
 * then status='needs_review'.
 */
export async function classifyTender(
  provider: LlmProvider,
  input: ClassificationInput,
  opts: ClassifyOptions = {},
): Promise<ClassificationOutcome> {
  const user = buildUserPrompt(input);
  let inputTokens = 0;
  let outputTokens = 0;
  let modelId: string | undefined;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const res = await provider.complete({
      system: SYSTEM_PROMPT + (attempt === 2 ? `\n${RETRY_HINT}` : ''),
      user,
      jsonSchema: CLASSIFICATION_JSON_SCHEMA,
      maxOutputTokens: opts.maxOutputTokens ?? 600,
      temperature: opts.temperature ?? 0,
      timeoutMs: opts.timeoutMs ?? 30_000,
    });
    inputTokens += res.inputTokens;
    outputTokens += res.outputTokens;
    modelId = res.modelId;

    let failure: string | null = null;
    let result: ClassificationResult | undefined;
    try {
      const parsed = classificationResultSchema.safeParse(JSON.parse(stripCodeFence(res.text)));
      if (parsed.success) {
        result = parsed.data;
        failure = postCheck(result, input, user);
      } else {
        failure = 'schema validation failed';
      }
    } catch {
      failure = 'response is not valid JSON';
    }

    if (failure === null && result) {
      return { status: 'ok', result, attempts: attempt, inputTokens, outputTokens, modelId };
    }
    if (attempt === 2) {
      return { status: 'needs_review', reason: failure, attempts: attempt, inputTokens, outputTokens, modelId };
    }
  }
  // Unreachable — loop always returns.
  return { status: 'needs_review', reason: 'exhausted', attempts: 2, inputTokens, outputTokens, modelId };
}

/** Digest gate (LLD §8.4.5): conservative default until calibration. */
export const DEFAULT_RELEVANCE_THRESHOLD = 0.8;

export function isDigestEligible(
  outcome: ClassificationOutcome,
  threshold = DEFAULT_RELEVANCE_THRESHOLD,
): boolean {
  return (
    outcome.status === 'ok' &&
    outcome.result !== undefined &&
    outcome.result.is_relevant &&
    outcome.result.confidence >= threshold &&
    !outcome.result.uncertain
  );
}
