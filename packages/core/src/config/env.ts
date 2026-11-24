// Environment variable names only — never secret values (LLD §14).
// Parsing produces a typed AppConfig; missing optional vars stay undefined.

export const ENV_NAMES = [
  'MODE', // 'pilot' | 'paid'
  'BILLING_ENABLED', // 'true'|'false'; requires legal_gate_cleared_at (AC-22)
  'LEGAL_GATE_CLEARED_AT', // ISO timestamp set by Ben after lawyer review
  'APP_BASE_URL',
  'DB_URL_WORKER',
  'DB_URL_WEB',
  'TOKEN_HMAC_SECRET',
  'TOKEN_HMAC_KID',
  'RESEND_API_KEY',
  'RESEND_WEBHOOK_SECRET',
  'BILLING_WEBHOOK_SECRET',
  'LLM_PROVIDER',
  'LLM_MODEL',
  'LLM_API_KEY',
  'LLM_DAILY_BUDGET', // hard daily token/spend cap
  'TYPESAFE_API_KEY', // jev provider key (secret; worker only)
  'TYPESAFE_MODEL', // optional jev model override; unset = service default
  'JEV_MIN_CONFIDENCE', // digest gate for the jev path (default 0.55)
  'JEV_TIMEOUT_MS', // bound on each TypeSafe call (default 15000)
  'SUMMARIES_ENABLED', // 'true'|'false'; pilot digests have no LLM summaries
  'PROMPT_VERSION',
  'SENDING_DOMAIN',
  'REPLY_TO',
  'OPS_ALERT_TO',
  'UA_PRODUCT_URL',
  'UA_CONTACT',
  'INTERNAL_HEALTH_TOKEN',
  'DATAGOV_RESOURCE_ID', // CKAN datastore resource id (TBD per LLD §4.1)
  'DATAGOV_RESOURCE_URL', // direct single-file resource URL (preferred)
  'DATAGOV_DATASET_URL', // dataset page — provenance + official_url fallback
  'MRGOV_LISTING_URL', // listing URL template; '{page}' placeholder or ?page=N
] as const;

export type EnvName = (typeof ENV_NAMES)[number];

export type Mode = 'pilot' | 'paid';

export interface AppConfig {
  mode: Mode;
  billingEnabled: boolean;
  legalGateClearedAt: string | null;
  appBaseUrl?: string;
  dbUrlWorker?: string;
  dbUrlWeb?: string;
  tokenHmacSecret?: string;
  tokenHmacKid?: string;
  resendApiKey?: string;
  resendWebhookSecret?: string;
  billingWebhookSecret?: string;
  llmProvider?: string;
  llmModel?: string;
  llmApiKey?: string;
  llmDailyBudget?: number;
  typesafeApiKey?: string;
  typesafeModel?: string;
  jevMinConfidence: number;
  jevTimeoutMs: number;
  summariesEnabled: boolean;
  promptVersion: string;
  sendingDomain?: string;
  replyTo?: string;
  opsAlertTo?: string;
  uaProductUrl?: string;
  uaContact?: string;
  internalHealthToken?: string;
  datagovResourceId?: string;
  datagovResourceUrl?: string;
  datagovDatasetUrl?: string;
  mrgovListingUrl?: string;
}

export class ConfigError extends Error {}

/** Digest confidence gate for the jev classifier path (PRO-812). */
export const DEFAULT_JEV_MIN_CONFIDENCE = 0.55;
/** Bound on each TypeSafe API call (PRO-818). */
export const DEFAULT_JEV_TIMEOUT_MS = 15_000;

function opt(env: Record<string, string | undefined>, name: EnvName): string | undefined {
  const v = env[name];
  return v === undefined || v === '' ? undefined : v;
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const rawMode = env['MODE'] ?? 'pilot';
  if (rawMode !== 'pilot' && rawMode !== 'paid') {
    throw new ConfigError(`MODE must be 'pilot' or 'paid', got '${rawMode}'`);
  }
  const billingEnabled = env['BILLING_ENABLED'] === 'true';
  const legalGateClearedAt = opt(env, 'LEGAL_GATE_CLEARED_AT') ?? null;

  const cfg: AppConfig = {
    mode: rawMode,
    billingEnabled,
    legalGateClearedAt,
    jevMinConfidence: DEFAULT_JEV_MIN_CONFIDENCE,
    jevTimeoutMs: DEFAULT_JEV_TIMEOUT_MS,
    summariesEnabled: env['SUMMARIES_ENABLED'] === 'true',
    promptVersion: env['PROMPT_VERSION'] ?? 'v1',
  };
  const optStr = (name: EnvName, key: keyof AppConfig) => {
    const v = opt(env, name);
    if (v !== undefined) (cfg as unknown as Record<string, unknown>)[key] = v;
  };
  optStr('APP_BASE_URL', 'appBaseUrl');
  optStr('DB_URL_WORKER', 'dbUrlWorker');
  optStr('DB_URL_WEB', 'dbUrlWeb');
  optStr('TOKEN_HMAC_SECRET', 'tokenHmacSecret');
  optStr('TOKEN_HMAC_KID', 'tokenHmacKid');
  optStr('RESEND_API_KEY', 'resendApiKey');
  optStr('RESEND_WEBHOOK_SECRET', 'resendWebhookSecret');
  optStr('BILLING_WEBHOOK_SECRET', 'billingWebhookSecret');
  optStr('LLM_PROVIDER', 'llmProvider');
  optStr('LLM_MODEL', 'llmModel');
  optStr('LLM_API_KEY', 'llmApiKey');
  optStr('TYPESAFE_API_KEY', 'typesafeApiKey');
  optStr('TYPESAFE_MODEL', 'typesafeModel');
  optStr('SENDING_DOMAIN', 'sendingDomain');
  optStr('REPLY_TO', 'replyTo');
  optStr('OPS_ALERT_TO', 'opsAlertTo');
  optStr('UA_PRODUCT_URL', 'uaProductUrl');
  optStr('UA_CONTACT', 'uaContact');
  optStr('INTERNAL_HEALTH_TOKEN', 'internalHealthToken');
  optStr('DATAGOV_RESOURCE_ID', 'datagovResourceId');
  optStr('DATAGOV_RESOURCE_URL', 'datagovResourceUrl');
  optStr('DATAGOV_DATASET_URL', 'datagovDatasetUrl');
  optStr('MRGOV_LISTING_URL', 'mrgovListingUrl');
  const budget = opt(env, 'LLM_DAILY_BUDGET');
  if (budget !== undefined) {
    const n = Number(budget);
    if (!Number.isFinite(n) || n <= 0) throw new ConfigError('LLM_DAILY_BUDGET must be positive');
    cfg.llmDailyBudget = n;
  }
  const jevMin = opt(env, 'JEV_MIN_CONFIDENCE');
  if (jevMin !== undefined) {
    const n = Number(jevMin);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      throw new ConfigError('JEV_MIN_CONFIDENCE must be a number in [0,1]');
    }
    cfg.jevMinConfidence = n;
  }
  const jevTimeout = opt(env, 'JEV_TIMEOUT_MS');
  if (jevTimeout !== undefined) {
    const n = Number(jevTimeout);
    if (!Number.isFinite(n) || n <= 0) throw new ConfigError('JEV_TIMEOUT_MS must be positive');
    cfg.jevTimeoutMs = n;
  }

  assertBillingGate(cfg);
  return cfg;
}

/**
 * AC-22 (code side): billing may not be enabled while the legal gate is null.
 * Throws if the combination is invalid; callers can rely on
 * `cfg.billingEnabled` being safe to consult after loadConfig returns.
 */
export function assertBillingGate(cfg: Pick<AppConfig, 'billingEnabled' | 'legalGateClearedAt'>): void {
  if (cfg.billingEnabled && cfg.legalGateClearedAt === null) {
    throw new ConfigError('BILLING_ENABLED=true requires LEGAL_GATE_CLEARED_AT (lawyer review)');
  }
}
