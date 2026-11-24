import type { AdapterContext } from '@michrazon/core';

const ROBOTS_URL = 'https://mr.gov.il/robots.txt';

/**
 * mr.gov.il has no robots.txt today (request redirects to the homepage) but
 * the system behaves as if one exists (LLD §4.2): every run fetches it, and
 * if a real robots file appears with a relevant Disallow the adapter stops.
 *
 * Returns { allowed, reason }. Fails closed toward courtesy: an HTML body or
 * a redirected homepage response counts as "no robots file" and is allowed;
 * a real robots.txt is parsed and honored.
 */
export async function checkRobots(
  ctx: AdapterContext,
  paths: readonly string[],
): Promise<{ allowed: boolean; reason: string }> {
  let res;
  try {
    res = await ctx.http.get(ROBOTS_URL, 'mrgov_listing');
  } catch {
    // Fetch failure (blocked/down) — behave as if unreachable, allow the run
    // and let the ingest recorder surface it.
    return { allowed: true, reason: 'robots.txt unreachable' };
  }
  const finalUrl = new URL(res.url);
  if (finalUrl.pathname !== '/robots.txt') {
    return { allowed: true, reason: 'robots.txt redirects to site (absent)' };
  }
  const body = (await res.text()).slice(0, 64 * 1024);
  if (/^\s*</.test(body) || /<html[\s>]/i.test(body)) {
    return { allowed: true, reason: 'robots.txt served HTML (absent)' };
  }
  const disallowed = disallowedPaths(body);
  for (const p of paths) {
    if (disallowed.some((d) => d !== '/' && p.startsWith(d)) || disallowed.includes('/')) {
      return { allowed: false, reason: `robots.txt disallows ${p}` };
    }
  }
  return { allowed: true, reason: 'robots.txt allows listing paths' };
}

/** Disallow paths from the User-agent: * group (first matching group wins). */
export function disallowedPaths(robotsBody: string): string[] {
  const groups = robotsBody.split(/\n\s*\n/);
  for (const group of groups) {
    const lines = group.split('\n').map((l) => l.trim());
    const agents = lines
      .filter((l) => /^user-agent\s*:/i.test(l))
      .map((l) => l.split(':')[1]?.trim().toLowerCase());
    if (agents.includes('*')) {
      return lines
        .filter((l) => /^disallow\s*:/i.test(l))
        .map((l) => l.split(':')[1]?.trim() ?? '')
        .filter(Boolean);
    }
  }
  return [];
}
