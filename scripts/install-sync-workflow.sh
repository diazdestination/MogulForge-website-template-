#!/usr/bin/env bash
# =============================================================================
# install-sync-workflow.sh
#
# One-time setup: moves the staged sync-from-upstream GitHub Actions workflow
# into the correct location and pushes it.
#
# Run this once from any local clone of a Painless CRM template repository:
#
#   bash scripts/install-sync-workflow.sh
#
# Why this script exists
# ----------------------
# The automated template-push tooling runs inside Replit with a GitHub OAuth
# token that has `repo` scope but NOT `workflow` scope.  GitHub's API rejects
# writes to .github/workflows/ without that extra scope.  To work around this
# the workflow file is shipped as .github/sync-from-upstream.workflow.yml and
# this script moves it into place.  A normal `git push` from a local machine
# does NOT require `workflow` scope — only the REST API does.
# =============================================================================
set -euo pipefail

STAGED=".github/sync-from-upstream.workflow.yml"
DEST=".github/workflows/sync-from-upstream.yml"

if [[ ! -f "$STAGED" ]]; then
  echo "❌  Staged workflow file not found: $STAGED" >&2
  echo "    Make sure you are running this script from the repository root." >&2
  exit 1
fi

if [[ -f "$DEST" ]]; then
  echo "ℹ️   $DEST already exists — nothing to do."
  exit 0
fi

echo "ℹ️   Installing sync-from-upstream GitHub Actions workflow …"
mkdir -p "$(dirname "$DEST")"
cp "$STAGED" "$DEST"

git add "$DEST"
git commit -m "ci: activate sync-from-upstream workflow"
git push

echo ""
echo "✅  Done!  The workflow is now active."
echo "    Go to your repository's Actions tab → 'Sync from upstream monorepo'"
echo "    to trigger a manual sync."
