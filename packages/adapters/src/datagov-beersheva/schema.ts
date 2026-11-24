import { z } from 'zod';

// Green-source normalized output (LLD §4.1): all NormalizedTender fields are
// permitted; open_data_fields holds extra open-data columns from the record.
export const datagovTenderSchema = z
  .object({
    source_id: z.literal('datagov_beersheva'),
    source_tender_id: z.string().min(1),
    title: z.string().min(1),
    publisher: z.string().optional(),
    published_at: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    submission_deadline: z.string().optional(),
    official_url: z.string().url(),
    open_data_fields: z.record(z.unknown()).optional(),
  })
  .strict();

export type DatagovTender = z.infer<typeof datagovTenderSchema>;
