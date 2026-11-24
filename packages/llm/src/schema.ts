import { z } from 'zod';

// Structured input to the classifier (LLD §8.2). Facts only — for yellow
// sources this is exactly MrGovFacts minus official_url; the input type
// carries NO free-text/page body so raw HTML can never reach the prompt.
export interface ClassificationInput {
  source_tier: 'green' | 'yellow';
  title: string;
  publisher?: string;
  published_at?: string;
  submission_deadline?: string;
  /** Green sources only. Must be absent for yellow (enforced at build time). */
  open_data_fields?: Record<string, unknown>;
}

export const FACTS_USED_ENUM = [
  'title',
  'publisher',
  'published_at',
  'submission_deadline',
  'open_data_fields',
] as const;

export const CATEGORY_ENUM = [
  'software_dev',
  'web_mobile',
  'cloud_devops',
  'security',
  'data_bi',
  'ai_ml_automation',
  'ux_marketing_digital',
  'it_services',
  'other_not_relevant',
] as const;

export const classificationResultSchema = z
  .object({
    is_relevant: z.boolean(),
    confidence: z.number().min(0).max(1),
    category: z.enum(CATEGORY_ENUM),
    summary_he: z.string().max(280).nullable(),
    facts_used: z.array(z.enum(FACTS_USED_ENUM)).min(1),
    uncertain: z.boolean(),
  })
  .strict();

export type ClassificationResult = z.infer<typeof classificationResultSchema>;

// JSON Schema handed to providers that support structured output (LLD §8.3).
// Parsing never trusts it alone — every response is re-validated with zod.
export const CLASSIFICATION_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['is_relevant', 'confidence', 'category', 'summary_he', 'facts_used', 'uncertain'],
  properties: {
    is_relevant: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    category: { type: 'string', enum: [...CATEGORY_ENUM] },
    summary_he: { type: ['string', 'null'], maxLength: 280 },
    facts_used: {
      type: 'array',
      items: { type: 'string', enum: [...FACTS_USED_ENUM] },
      minItems: 1,
    },
    uncertain: { type: 'boolean' },
  },
} as const;
