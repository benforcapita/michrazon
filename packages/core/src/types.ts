// Shared contracts (LLD §4, §8.1). Implementations live in the owning packages.

export type SourceId = 'datagov_beersheva' | 'mrgov_listing';
export type SourceTier = 'green' | 'yellow';

export interface NormalizedTender {
  source_id: SourceId;
  source_tender_id: string; // required; skip record if missing
  title: string;
  publisher?: string;
  published_at?: string; // ISO date
  submission_deadline?: string; // ISO datetime, Asia/Jerusalem normalized
  official_url: string; // listing page URL, validated by guard (not a document)
  open_data_fields?: Record<string, unknown>; // green sources only; never for yellow
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** A single HTTP response as seen through the guard. */
export interface GuardedResponse {
  readonly status: number;
  readonly url: string; // final URL after redirects (already re-checked)
  readonly headers: Record<string, string>;
  /** Body text. For yellow sources this is guaranteed to be text/html. */
  text(): Promise<string>;
}

/**
 * The ONLY network I/O path for adapters (LLD §4 rule 2).
 * Enforces allowlist + denylist + document rejection + rate limit + UA + backoff.
 */
export interface GuardedHttp {
  get(url: string, sourceId: SourceId): Promise<GuardedResponse>;
}

export interface AdapterContext {
  http: GuardedHttp; // the only permitted network path
  now(): Date;
  log: Logger;
}

export interface SourceAdapter {
  readonly id: SourceId;
  readonly tier: SourceTier;
  /** Async generator; adapter calls ctx.http for every network access. */
  fetchSince(ctx: AdapterContext, since: Date): AsyncIterable<NormalizedTender>;
}

// ---------- LLM (LLD §8.1) ----------

export interface LlmCompleteRequest {
  system: string;
  user: string;
  jsonSchema: object; // used for structured output where supported
  maxOutputTokens: number;
  temperature: number; // 0 - 0.2
  timeoutMs: number;
}

export interface LlmCompleteResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  modelId: string;
}

export interface LlmProvider {
  readonly id: string; // e.g. config LLM_PROVIDER
  complete(req: LlmCompleteRequest): Promise<LlmCompleteResult>;
}

// ---------- Mail (LLD §9) ----------

/** Fully-rendered outbound email, ready for a transport. */
export interface OutboundEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>; // includes List-Unsubscribe + List-Unsubscribe-Post
}

/** Transport port — implemented by the Resend sender (W1-G) or a mock. */
export interface MailTransport {
  send(email: OutboundEmail): Promise<{ messageId: string }>;
}
