// Compliance suite (W2-B): static guarantees that can't regress silently.
// CI scripts cover red-domain scans and the 2021 dataset; these tests cover
// the same invariants at unit level plus tracking/deps/schema checks.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLOWLIST, DENYLIST } from '@michrazon/core';
import {
  renderConfirmHtml,
  renderConfirmText,
  renderDigestHtml,
  renderDigestText,
  type DigestView,
} from '@michrazon/mail';

const DIGEST_VIEW: DigestView = {
  date_he: '15.01.2026',
  items: [
    {
      title: 'מכרז', tender_id: '1', official_url: 'https://data.gov.il/x',
      source_label: 'data.gov.il', summary_he: 'סיכום',
    },
  ],
  attributions: ['att'],
  unsubscribe_url: 'https://x.example/u',
  prefs_url: 'https://x.example/p',
  publisher_block: 'x',
};

const ROOT = join(__dirname, '../..');

function walk(dir: string, files: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.git' || e === 'dist' || e === '.next') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, files);
    else files.push(p);
  }
  return files;
}

const sourceFiles = (): string[] =>
  walk(ROOT).filter((f) => /\.(ts|tsx|sql|json|sh)$/.test(f) && !f.includes('docs/'));

const RED = ['tel-aviv.gov.il', 'jerusalem.muni.il'];

describe('red domains', () => {
  it('denylist contains both; allowlist never does (AC-01)', () => {
    for (const d of RED) {
      expect(DENYLIST).toContain(d);
      expect(ALLOWLIST).not.toContain(d);
    }
  });

  it('red domains appear only in guard/denylist enforcement, CI, migrations, tests', () => {
    const allowed = /guard|secret-scan|check-red|migrations|tests|summaries/;
    for (const f of sourceFiles()) {
      const text = readFileSync(f, 'utf8');
      if (RED.some((d) => text.includes(d))) {
        expect(allowed.test(f), `${f} references a red domain`).toBe(true);
      }
    }
  });
});

describe('no tracking (AC-12)', () => {
  const ANALYTICS = /posthog|segment|mixpanel|gtag|google-analytics|amplitude|hotjar|@sentry|plausible|matomo/i;

  it('no analytics packages in any package.json', () => {
    for (const f of walk(ROOT).filter((f) => f.endsWith('package.json'))) {
      const pkg = JSON.parse(readFileSync(f, 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
        expect(ANALYTICS.test(dep), `${f} depends on ${dep}`).toBe(false);
      }
    }
  });

  it('rendered templates contain no tracking artifacts', () => {
    for (const rendered of [
      renderDigestHtml(DIGEST_VIEW),
      renderDigestText(DIGEST_VIEW),
      renderConfirmHtml({ confirm_url: 'https://x.example/c' }),
      renderConfirmText({ confirm_url: 'https://x.example/c' }),
    ]) {
      expect(rendered).not.toMatch(/utm_[a-z]+=/i);
      expect(rendered).not.toMatch(/<img\b/i);
      expect(rendered).not.toMatch(/tracking|pixel|beacon/i);
    }
  });

  it('schema has no IP/UA/session/cookie columns', () => {
    const sql = readFileSync(join(ROOT, 'db/migrations/0001_init.sql'), 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(sql).not.toMatch(/\b(ip|ip_addr|ip_address|user_agent|session_id|cookie)\b/i);
  });

  it('no Set-Cookie in web code', () => {
    for (const f of walk(join(ROOT, 'apps/web')).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))) {
      expect(readFileSync(f, 'utf8')).not.toMatch(/set-cookie/i);
    }
  });
});

describe('source seeds and 2021 dataset (AC-06)', () => {
  it('all seeded sources are disabled', () => {
    const sql = readFileSync(join(ROOT, 'db/migrations/0001_init.sql'), 'utf8');
    const seed = sql.slice(sql.indexOf('insert into sources'));
    expect(seed).not.toMatch(/,true,/);
  });

  it('no reference to the 2021 tenders report dataset', () => {
    for (const f of sourceFiles().filter((f) => !f.includes('scripts/ci/') && !f.includes('compliance.test.ts'))) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/\u05D3\u05D5\u05D7 \u05DE\u05DB\u05E8\u05D6\u05D9\u05DD/);
    }
  });
});
