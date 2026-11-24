#!/usr/bin/env bash
# T-GUARD-1 / AC-01 stub: Tel Aviv-Yafo and Jerusalem hosts may appear ONLY in
# the denylist implementation, tests, docs, and CI scripts. Anywhere else
# (allowlists, sources seed/config, app code) fails the build.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

red='tel-aviv\.gov\.il|jerusalem\.muni\.il'
allowed='^(packages/core/src/guard/|tests/|docs/|scripts/ci/|README\.md|docs/runbook\.md)'

fail=0

# 1) No red domain inside an ALLOWLIST definition line.
if git grep -nE 'ALLOWLIST' -- 'packages' 'apps' 2>/dev/null | grep -nE "$red" >/dev/null; then
  echo "check-red-domains: red domain found inside an ALLOWLIST definition"
  git grep -nE 'ALLOWLIST' -- 'packages' 'apps' | grep -nE "$red" || true
  fail=1
fi

# 2) No red domain anywhere outside the sanctioned paths.
while IFS= read -r file; do
  if ! echo "$file" | grep -qE "$allowed"; then
    echo "check-red-domains: red domain present in unsanctioned file: $file"
    fail=1
  fi
done < <(git grep -lE "$red" -- . || true)

# 3) Red domains must not be seeded as sources.
if git grep -nE "$red" -- 'db/migrations' 'infra' 2>/dev/null | grep -vE '^$' >/dev/null; then
  echo "check-red-domains: red domain found under db/migrations or infra"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "check-red-domains: clean"
