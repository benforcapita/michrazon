// Minimal request/response types so handlers stay framework-free and
// testable; Next routes adapt Request -> HandlerRequest and Result -> Response.

export interface HandlerRequest {
  method: string;
  /** Parsed body (JSON or form) — adapter responsibility. */
  body?: Record<string, unknown>;
  query?: Record<string, string>;
  /** Client key for rate limiting (e.g. forwarded IP), never stored. */
  clientKey?: string;
  headers?: Record<string, string>;
}

export interface HandlerResult {
  status: number;
  body: unknown; // object -> JSON; string -> html/text
  headers?: Record<string, string>;
  /** 'json' (default) | 'html' | 'text' */
  contentType?: 'json' | 'html' | 'text';
}

export const json = (status: number, body: unknown): HandlerResult => ({ status, body });
export const html = (status: number, body: string): HandlerResult => ({
  status,
  body,
  contentType: 'html',
});
