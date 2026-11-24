import { NextRequest, NextResponse } from 'next/server';
import { handleBillingWebhook } from '../../../../src/lib/webhooks';
import { getWebhookDeps } from '../../../../src/lib/webhookDeps';
import { toResponse } from '../../../../src/lib/nextAdapter';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const headers: Record<string, string> = {};
  const sig = req.headers.get('x-webhook-signature');
  if (sig) headers['x-webhook-signature'] = sig;
  return toResponse(await handleBillingWebhook({ method: 'POST', headers }, getWebhookDeps()));
}
