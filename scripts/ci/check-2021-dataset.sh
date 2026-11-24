#!/usr/bin/env bash
# AC-06 stub: the 2021 "דוח מכרזים" (annual tender report) dataset of the Israeli
# Government Procurement Administration must never be referenced in code,
# config, migrations, or fixtures. Design docs may discuss it.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

pat='דוח מכרזים|tenders-report|annual.tender|michrazim-2021'
allowed='^(docs/|scripts/ci/|README\.md)'

fail=0
while IFS= read -r file; do
  if ! echo "$file" | grep -qE "$allowed"; then
    echo "check-2021-dataset: 2021 dataset reference found in: $file"
    fail=1
  fi
done < <(git grep -lE "$pat" -- . || true)

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "check-2021-dataset: clean"
