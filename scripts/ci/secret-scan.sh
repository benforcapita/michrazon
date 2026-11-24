#!/usr/bin/env bash
# Secret scan: fails if tracked files contain secret-looking values.
# Env *names* are fine; this looks for actual key material.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

patterns='-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|sk-[A-Za-z0-9]{20,}|re_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|postgres(ql)?://[^[:space:]/]+:[^@[:space:]]+@|whsec_[A-Za-z0-9]{20,}'

# Connection strings to local throwaway databases are not secrets.
hits="$(
  git grep -nIE -e "$patterns" -- . \
    | grep -vE 'postgres(ql)?://[^[:space:]/]+:[^@[:space:]]+@(localhost|127\.0\.0\.1)(:[^/[:space:]]+)?/' \
    || true
)"
if [ -n "$hits" ]; then
  echo "secret-scan: possible secret material found:"
  echo "$hits"
  exit 1
fi
echo "secret-scan: clean"
