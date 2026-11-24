import { NextRequest, NextResponse } from 'next/server';
import { handleHealth } from '../../../../src/lib/webhooks';
import { getWebhookDeps } from '../../../../src/lib/webhookDeps';
import { toResponse } from '../../../../src/lib/nextAdapter';

export async function GET(req: NextRequest): Promise<NextResponse> {
  return toResponse(
    await handleHealth(
      {
        method: 'GET',
        query: Object.fromEntries(req.nextUrl.searchParams.entries()),
        headers: { authorization: req.headers.get('authorization') ?? '' },
      },
      getWebhookDeps(),
    ),
  );
}
