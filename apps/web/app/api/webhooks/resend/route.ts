import { NextRequest, NextResponse } from 'next/server';
import { handleResendWebhook } from '../../../../src/lib/webhooks';
import { getWebhookDeps } from '../../../../src/lib/webhookDeps';
import { toResponse } from '../../../../src/lib/nextAdapter';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();
  const headers: Record<string, string> = {};
  for (const k of ['svix-id', 'svix-timestamp', 'svix-signature']) {
    headers[k] = req.headers.get(k) ?? '';
  }
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'bad payload' }, { status: 400 });
  }
  return toResponse(await handleResendWebhook({ method: 'POST', body, rawBody, headers }, getWebhookDeps()));
}
