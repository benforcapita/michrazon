import { checkDailyBudget, classifyTender, PROMPT_VERSION, type ClassificationInput } from '@michrazon/llm';
import { jerusalemDate } from '@michrazon/core';
import type { RunResult } from '@michrazon/ops';
import type { WorkerDeps } from '../deps.ts';

const TIER_BY_SOURCE = { datagov_beersheva: 'green', mrgov_listing: 'yellow' } as const;
const BATCH = 50;

export async function runClassify(deps: WorkerDeps): Promise<RunResult | null> {
  return deps.recorder.runOnce('classify', null, async () => {
    const counts: Record<string, number> = { classified: 0, needs_review: 0, budget_stopped: 0 };
    const tenders = await deps.db.listUnclassified(BATCH);
    const today = jerusalemDate(deps.now());

    for (const tender of tenders) {
      const spent = await deps.db.sumClassificationTokensOnDate(today);
      if (!checkDailyBudget(spent.input + spent.output, deps.llmDailyBudgetTokens).allowed) {
        counts['budget_stopped'] = tenders.length - counts['classified']! - counts['needs_review']!;
        // AC-25: budget breach stops classification and alerts — 'partial'
        // triggers RunRecorder's warn alert.
        return { status: 'partial', counts, error: 'LLM_DAILY_BUDGET reached; remaining tenders stay for the next run' };
      }
      const input: ClassificationInput = {
        source_tier: TIER_BY_SOURCE[tender.source_id as keyof typeof TIER_BY_SOURCE] ?? 'green',
        title: tender.title,
        publisher: tender.publisher ?? undefined,
        published_at: tender.published_at ?? undefined,
        submission_deadline: tender.submission_deadline ?? undefined,
        open_data_fields: tender.open_data_fields ?? undefined,
      };
      const outcome = await classifyTender(deps.llm, input);
      await deps.db.insertClassification({
        tender_id: tender.id,
        input_hash: tender.content_hash, // hash-invalidates on tender update (join in listDigestEligible)
        model_id: outcome.modelId ?? deps.llm.id,
        prompt_version: PROMPT_VERSION,
        is_relevant: outcome.result?.is_relevant ?? false,
        confidence: outcome.result?.confidence ?? 0,
        category: outcome.result?.category ?? 'other_not_relevant',
        summary_he: outcome.result?.summary_he ?? null,
        facts_used: outcome.result?.facts_used ?? [],
        uncertain: outcome.result?.uncertain ?? true,
        status: outcome.status,
        input_tokens: outcome.inputTokens,
        output_tokens: outcome.outputTokens,
      });
      counts[outcome.status === 'ok' ? 'classified' : 'needs_review'] =
        (counts[outcome.status === 'ok' ? 'classified' : 'needs_review'] ?? 0) + 1;
    }
    return { status: 'ok', counts };
  });
}
