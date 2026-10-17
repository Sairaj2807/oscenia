#!/usr/bin/env bash
# Prints the LIVE state of the Oscenia repo for a starting Claude session (wired as a SessionStart hook; see
# CLAUDE.md). Read-only: git queries and a few lines of the status doc. Never prints a secret, never changes anything.
ROOT="$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd)" || exit 0
cd "$ROOT" || exit 0

echo "=== OSCENIA: live repo state (printed automatically at session start) ==="
echo "repo: $ROOT   (real remote: Sairaj2807/oscenia)"
echo "branch: $(git branch --show-current 2>/dev/null)   |   commits not on origin/main: $(git rev-list --count origin/main..HEAD 2>/dev/null || echo '?')   |   uncommitted files: $(git status --short 2>/dev/null | wc -l | tr -d ' ')"
git status --short 2>/dev/null | head -6
echo "last commits:"; git log --oneline -6 2>/dev/null | sed 's/^/  /'
echo
if [[ -f docs/GO-LIVE-STATUS.md ]]; then
  echo "--- from docs/GO-LIVE-STATUS.md ---"
  sed -n '/^## In one paragraph/,/^## What is live/p' docs/GO-LIVE-STATUS.md | sed '$d' | sed '/^$/N;/^\n$/D'
  echo "What is NOT done (excerpt):"
  sed -n '/^## What is NOT done/,/^## Decisions still open/p' docs/GO-LIVE-STATUS.md | grep '^|' | grep -v '^|---' | cut -c1-170 | head -12
fi
echo
echo "READ FIRST: docs/GO-LIVE-STATUS.md, then deploy/vps/README.md (production runbook), then CLAUDE.md."
echo "CHECK PRODUCTION (no credentials needed): deploy/vps/smoke-test.sh"
echo "SERVER ACCESS: deploy/vps/ssh-run.py reads the root password from the VPS_PW env var; ask the owner for it, never store it."
echo "RULES: shared prod server (never stop/restart services; reload nginx only; ask before server changes) | never push/merge unless asked | never write secrets to files | short chat answers when asked."
echo "WHEN YOU FINISH: update docs/GO-LIVE-STATUS.md and the Claude memory notes (oscenia-open-items, oscenia-production-vps, oscenia-repo-structure)."
exit 0
