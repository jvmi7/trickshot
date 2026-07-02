#!/usr/bin/env bash
# The coverage FLOOR (see CLAUDE.md › TDD): fails when AGGREGATE line/function
# coverage of the unit-testable modules drops below the floors — it catches
# "deleted the tests, kept the code", not a number to climb.
#
# Enforced here, NOT via bunfig's `coverageThreshold`: bun (1.3.x) applies that
# threshold per file across every metric, so any by-design-partially-covered
# module (e.g. claudeSuggest.ts, whose live call is untestable) fails ANY useful
# floor. The excluded-by-policy files live in bunfig coveragePathIgnorePatterns.
set -euo pipefail
cd "$(dirname "$0")/.."

LINES_FLOOR=75
FUNCS_FLOOR=60

out=$(bun test --coverage 2>&1) || { echo "$out"; exit 1; }
echo "$out"

row=$(echo "$out" | grep -E '^\s*All files' | head -1)
if [ -z "$row" ]; then
  echo "coverage-floor: no 'All files' row in bun test --coverage output" >&2
  exit 1
fi

# Row shape: "All files | <funcs%> | <lines%> |"
funcs=$(echo "$row" | awk -F'|' '{gsub(/ /,"",$2); print $2}')
lines=$(echo "$row" | awk -F'|' '{gsub(/ /,"",$3); print $3}')

fail=0
awk -v v="$funcs" -v f="$FUNCS_FLOOR" 'BEGIN { exit !(v+0 < f) }' && {
  echo "coverage-floor: function coverage ${funcs}% is below the ${FUNCS_FLOOR}% floor" >&2
  fail=1
}
awk -v v="$lines" -v f="$LINES_FLOOR" 'BEGIN { exit !(v+0 < f) }' && {
  echo "coverage-floor: line coverage ${lines}% is below the ${LINES_FLOOR}% floor" >&2
  fail=1
}

if [ "$fail" -eq 0 ]; then
  echo "coverage-floor: OK (lines ${lines}% >= ${LINES_FLOOR}%, functions ${funcs}% >= ${FUNCS_FLOOR}%)"
fi
exit "$fail"
