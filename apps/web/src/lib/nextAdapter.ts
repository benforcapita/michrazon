import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import type { HandlerRequest, HandlerResult } from './http';
import type { WebDeps } from './handlers';

async function parseBody(req: NextRequest): Promise<Record<string, unknown> | undefined> {
  const ct = req.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try {
      return (await req.json()) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  if (ct.includes('form')) {
    const form = await req.formData();
    const body: Record<string, unknown> = {};
    for (const [k, v] of form.entries()) body[k] = typeof v === 'string' ? v : v.name;
    return body;
  }
  return undefined;
}

export async function toHandlerRequest(req: NextRequest): Promise<HandlerRequest> {
  const query: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((v, k) => {
    query[k] = v;
  });
  return {
    method: req.method,
    body: await parseBody(req),
    query,
    clientKey: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown',
  };
}

// No cookies, ever (AC-12): responses carry only a content-type.
export function toResponse(result: HandlerResult): NextResponse {
  const headers: Record<string, string> = {};
  if (result.headers) Object.assign(headers, result.headers);
  if (result.contentType === 'html' || typeof result.body === 'string') {
    headers['content-type'] = 'text/html; charset=utf-8';
    return new NextResponse(String(result.body), { status: result.status, headers });
  }
  return NextResponse.json(result.body, { status: result.status, headers });
}

export function route(
  handler: (req: HandlerRequest, deps: WebDeps) => Promise<HandlerResult>,
  deps: WebDeps,
) {
  return async (req: NextRequest): Promise<NextResponse> =>
    toResponse(await handler(await toHandlerRequest(req), deps));
}
