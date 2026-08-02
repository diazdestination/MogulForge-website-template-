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

# Paths excluded from the "shared changed" check.
# Files that match any of these patterns are ignored when deciding whether a
# shared-dir edit should trigger a push to all three template repos.  Add to
# this list for doc-only or maintenance files that carry no runtime impact:
#
#   scripts/post-merge.sh  — edits to this script are meta / infra, not product
#   *.md                   — documentation changes never affect runtime behaviour
SHARED_EXCLUDE_PATTERNS=(
  "^scripts/post-merge\.sh$"
  "\.md$"
)

# Build a filtered view of the changed-file list for the shared-dir check.
_shared_changed_files() {
  local files="$CHANGED_FILES"
  for pat in "${SHARED_EXCLUDE_PATTERNS[@]}"; do
    files="$(echo "$files" | grep -v "$pat" || true)"
  done
  echo "$files"
}
SHARED_CHANGED_FILES="$(_shared_changed_files)"

_shared_changed_in() {
  [ -n "$SHARED_CHANGED_FILES" ] && echo "$SHARED_CHANGED_FILES" | grep -q "^${1}"
}

# Shared dirs: a change here affects every template repo.
# Note: uses the filtered file list so excluded paths (above) never trigger a push.
SHARED_CHANGED=false
if _shared_changed_in "artifacts/api-server/" || _shared_changed_in "lib/" || _shared_changed_in "scripts/"; then
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

  # _push_product runs the push and FAILS LOUDLY on any error so post-merge
  # exits non-zero and blocks the merge.  A failed push must never be silent.
  _push_product() {
    local product="$1"
    local label="$2"
    bash "$SCRIPT_DIR/push-to-product-repos.sh" "$product" || {
      echo "❌  $label template push FAILED — aborting post-merge." \
           "Fix the remote configuration or network issue, then re-run." >&2
      exit 1
    }
  }

  if $PUSH_CRM;     then _push_product crm     "CRM";     fi
  if $PUSH_MOBILE;  then _push_product mobile  "Mobile";  fi
  if $PUSH_WEBSITE; then _push_product website "Website"; fi
fi
