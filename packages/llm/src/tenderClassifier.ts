import type { LlmProvider, Logger } from '@michrazon/core';
import { classifyTender, type ClassificationOutcome, type ClassifyOptions } from './classifier';
import type { ClassificationInput } from './schema';

/**
 * Classifier-level abstraction (PRO-812): the worker's classify task calls
 * `classify` on a TenderClassifier, not `LlmProvider.complete`. Providers
 * whose API is not chat-completions shaped — TypeSafe Jev, the keyword
 * fallback — implement this directly instead of faking a text completion.
 */
export interface TenderClassifier {
  readonly id: string;
  classify(input: ClassificationInput): Promise<ClassificationOutcome>;
}

/**
 * The existing LLD §8.4 path: chat-completions provider + zod + post-check.
 * When summaries are disabled (pilot), summary_he is stripped after
 * validation — the provider call shape is unchanged.
 */
export class ChatCompletionsClassifier implements TenderClassifier {
  readonly id: string;

  constructor(
    private readonly provider: LlmProvider,
    private readonly opts: { summariesEnabled?: boolean; classify?: ClassifyOptions } = {},
  ) {
    this.id = provider.id;
  }

  async classify(input: ClassificationInput): Promise<ClassificationOutcome> {
    const out = await classifyTender(this.provider, input, this.opts.classify);
    if (!this.opts.summariesEnabled && out.result) {
      return { ...out, result: { ...out.result, summary_he: null } };
    }
    return out;
  }
}

/**
 * Wraps a primary classifier with a keyword-only fallback (PRO-812 §4). Any
 * primary error — missing key, HTTP failure, malformed response — routes the
 * tender to the fallback; the run never fails because the provider is down.
 * The fallback reason rides on the outcome so the pipeline run records it.
 */
export class KeywordFallbackClassifier implements TenderClassifier {
  readonly id: string;
  private warned = false;

  constructor(
    private readonly primary: TenderClassifier,
    private readonly fallback: TenderClassifier,
    private readonly log?: Logger,
  ) {
    this.id = primary.id;
  }

  async classify(input: ClassificationInput): Promise<ClassificationOutcome> {
    try {
      return await this.primary.classify(input);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      if (!this.warned) {
        this.warned = true;
        this.log?.warn('primary classifier failed; keyword fallback active', {
          primary: this.primary.id,
          reason,
        });
      }
      const out = await this.fallback.classify(input);
      return { ...out, modelId: 'keyword_fallback', fallbackReason: reason };
    }
  }
}
