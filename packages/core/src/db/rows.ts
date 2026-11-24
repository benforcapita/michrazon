// Row types matching the LLD §3 schema (db/migrations/0001_init.sql).
// Field names stay snake_case to mirror the tables exactly.

import type { SourceId, SourceTier } from '../types';

export type { SourceTier };

export type SubscriberStatus =
  | 'pending'
  | 'active'
  | 'unsubscribed'
  | 'cancelled'
  | 'bounced'
  | 'complained';

export type PlanType = 'pilot' | 'paid';

export type ConsentEvent =
  | 'signup_submitted'
  | 'confirmed'
  | 'unsubscribed'
  | 'cancelled'
  | 'bounced'
  | 'complained'
  | 'resubscribe_requested';

export type RunKind = 'ingest' | 'classify' | 'digest' | 'housekeeping';
export type RunStatus = 'running' | 'ok' | 'partial' | 'failed';
export type DeliveryStatus = 'queued' | 'sent' | 'failed' | 'skipped_suppressed';
export type SuppressionReason = 'unsubscribe' | 'cancel' | 'bounce' | 'complaint' | 'manual';
export type ClassificationStatus = 'ok' | 'needs_review' | 'failed';

export interface SourceRow {
  id: string;
  tier: SourceTier;
  host: string;
  enabled: boolean;
  min_interval_s: number;
  max_requests_per_run: number;
  attribution_text: string;
  notes: string | null;
}

export interface TenderRow {
  id: string;
  source_id: string;
  source_tender_id: string;
  title: string;
  publisher: string | null;
  published_at: string | null; // date
  submission_deadline: string | null; // timestamptz
  official_url: string;
  open_data_fields: Record<string, unknown> | null;
  content_hash: string;
  first_seen_at: string;
  last_seen_at: string;
  retired_at: string | null;
}

export interface TenderClassificationRow {
  id: string;
  tender_id: string;
  input_hash: string;
  model_id: string;
  prompt_version: string;
  is_relevant: boolean;
  confidence: number;
  category: string;
  summary_he: string | null;
  facts_used: string[];
  uncertain: boolean;
  status: ClassificationStatus;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
}

export interface SubscriberRow {
  id: string;
  email: string;
  email_norm: string;
  status: SubscriberStatus;
  plan: PlanType;
  pilot_ends_at: string | null;
  keywords: string[];
  created_at: string;
  confirmed_at: string | null;
  ended_at: string | null;
}

export interface ConsentRow {
  id: number;
  subscriber_id: string;
  event: ConsentEvent;
  at: string;
  text_version: string;
}

export interface SuppressionRow {
  email_norm: string;
  reason: SuppressionReason;
  created_at: string;
}

export interface DigestRow {
  id: string;
  digest_date: string; // Asia/Jerusalem calendar date
  built_at: string | null;
  item_count: number;
}

export interface DigestItemRow {
  digest_id: string;
  tender_id: string;
  classification_id: string | null;
  position: number;
}

export interface DigestDeliveryRow {
  digest_id: string;
  subscriber_id: string;
  status: DeliveryStatus;
  resend_message_id: string | null;
  error: string | null;
  attempts: number;
  updated_at: string;
}

export interface PipelineRunRow {
  id: number;
  kind: RunKind;
  source_id: string | null;
  task: string | null;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  counts: Record<string, number>;
  error: string | null;
}

export type { SourceId };
