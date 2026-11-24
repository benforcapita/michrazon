import { z } from 'zod';

// Facts-only contract for mr.gov.il (LLD §6.1). Yellow sources may emit ONLY
// these listing facts plus a link. .strict() fails on ANY extra key.
export const MrGovFacts = z
  .object({
    source_id: z.literal('mrgov_listing'),
    source_tender_id: z.string().min(1).max(64),
    title: z.string().min(1).max(500),
    publisher: z.string().max(200).optional(),
    published_at: z.string().date().optional(),
    submission_deadline: z.string().datetime({ offset: true }).optional(),
    official_url: z.string().url().max(1000),
  })
  .strict();

export type MrGovFactsT = z.infer<typeof MrGovFacts>;

// Explicitly forbidden field names (LLD §6.1) — asserted in tests, not just
// covered by .strict(). Anything document/booklet-derived is out of scope.
export const FORBIDDEN_MRGOV_KEYS = [
  'description',
  'body',
  'text',
  'scope',
  'requirements',
  'threshold_conditions',
  'guarantee',
  'attachments',
  'documents',
  'booklet',
  'pdf',
  'file',
  'html_raw',
  'open_data_fields',
] as const;
