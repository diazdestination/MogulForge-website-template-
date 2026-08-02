#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push
pnpm run typecheck
echo "--- API smoke test ---"
pnpm --filter @workspace/api-server run smoke
echo "--- Website smoke test ---"
pnpm --filter @workspace/website run smoke

# ---------------------------------------------------------------------------
# Conditional template-repo sync
#
# Detect which product directories (and shared dirs) changed in this merge
# and push only the affected template repos.  If a remote is not yet
# configured the push is skipped with a warning so the rest of post-merge
# still succeeds.
# ---------------------------------------------------------------------------
echo "--- Checking for product directory changes ---"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Try ORIG_HEAD first (real git post-merge hook), fall back to HEAD~1 (CI /
# manual invocation after a squash-merge), fall back to empty string.
CHANGED_FILES="$(git diff --name-only ORIG_HEAD HEAD 2>/dev/null \
  || git diff --name-only HEAD~1 HEAD 2>/dev/null \
  || true)"

_changed_in() {
  [ -n "$CHANGED_FILES" ] && echo "$CHANGED_FILES" | grep -q "^${1}"
}

# Shared dirs: a change here affects every template repo
SHARED_CHANGED=false
if _changed_in "artifacts/api-server/" || _changed_in "lib/" || _changed_in "scripts/"; then
  SHARED_CHANGED=true
fi

PUSH_CRM=false
PUSH_MOBILE=false
PUSH_WEBSITE=false

if $SHARED_CHANGED || _changed_in "artifacts/command-center/"; then PUSH_CRM=true; fi
if $SHARED_CHANGED || _changed_in "artifacts/mobile-crm/";     then PUSH_MOBILE=true; fi
if $SHARED_CHANGED || _changed_in "artifacts/website/";        then PUSH_WEBSITE=true; fi

if ! $PUSH_CRM && ! $PUSH_MOBILE && ! $PUSH_WEBSITE; then
  echo "No product directories changed — template sync skipped."
else
  echo "--- Syncing changed template repos ---"

  _push_safe() {
    local product="$1"
    local label="$2"
    # Run in a subshell so a non-zero exit (e.g. remote not configured)
    # prints a warning but does NOT abort post-merge.
    (
      bash "$SCRIPT_DIR/push-to-product-repos.sh" "$product"
    ) || echo "⚠️   $label template push skipped — remote not configured or push failed. Run manually: scripts/push-to-product-repos.sh $product"
  }

  $PUSH_CRM     && _push_safe crm     "CRM"
  $PUSH_MOBILE  && _push_safe mobile  "Mobile"
  $PUSH_WEBSITE && _push_safe website "Website"
fi
