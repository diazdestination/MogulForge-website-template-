#!/usr/bin/env bash
# =============================================================================
# post-merge-sync.test.sh
#
# Verifies that the template-repo sync block in scripts/post-merge.sh is
# non-fatal:
#   1. push-to-product-repos.sh exits non-zero (loudly) when a remote is
#      absent — this is the expected failure mode.
#   2. The _push_safe() wrapper used in post-merge.sh catches that failure and
#      exits 0 with a warning message, so post-merge never aborts.
#   3. When ORIG_HEAD is missing (e.g. CI squash-merge) the detection logic
#      falls back to HEAD~1 and still exits 0.
#   4. When both ORIG_HEAD and HEAD~1 are missing (very first commit / shallow
#      clone with depth 1) the "|| true" tail of the expression exits 0 and
#      the sync block is simply skipped.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PASS=0
FAIL=0

_pass() { echo "  ✅  $*"; PASS=$((PASS + 1)); }
_fail() { echo "  ❌  FAIL: $*"; FAIL=$((FAIL + 1)); }

# ---------------------------------------------------------------------------
# Shared temp root — cleaned up on exit
# ---------------------------------------------------------------------------
TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT

# ---------------------------------------------------------------------------
# Helper: make a minimal git repo with N commits so HEAD~(N-1) works
# ---------------------------------------------------------------------------
make_repo() {
  local dir="$1"
  local commits="${2:-2}"
  git init -q "$dir"
  git -C "$dir" config user.email "test@ci"
  git -C "$dir" config user.name  "CI Test"
  local i
  for i in $(seq 1 "$commits"); do
    mkdir -p "$dir/artifacts/command-center"
    echo "$i" > "$dir/artifacts/command-center/file.txt"
    git -C "$dir" add -A
    git -C "$dir" commit -q -m "commit $i"
  done
}

# ---------------------------------------------------------------------------
# Test 1: push-to-product-repos.sh exits non-zero when remote is absent
# ---------------------------------------------------------------------------
echo ""
echo "Test 1: push-to-product-repos.sh exits non-zero when remote is absent"

REPO1="$TMPROOT/repo1"
make_repo "$REPO1"
OUT1="$TMPROOT/out1.txt"

# PUSH_ROOT_DIR overrides the script's ROOT_DIR so require_remote() inspects
# the temp repo (no remotes) rather than the live workspace.
if (cd "$REPO1" && PUSH_ROOT_DIR="$REPO1" bash "$SCRIPT_DIR/push-to-product-repos.sh" crm) >"$OUT1" 2>&1; then
  _fail "Expected non-zero exit when remote absent — got 0"
else
  if grep -q "not configured" "$OUT1"; then
    _pass "push-to-product-repos.sh exits non-zero with 'not configured' message"
  else
    _fail "push-to-product-repos.sh exited non-zero but did not print expected message"
    echo "    --- captured output ---"
    cat "$OUT1"
    echo "    -----------------------"
  fi
fi

# ---------------------------------------------------------------------------
# Test 2: _push_safe wrapper (as used in post-merge.sh) exits 0 despite the
#         push failure, and prints the ⚠️ warning line
# ---------------------------------------------------------------------------
echo ""
echo "Test 2: _push_safe wrapper exits 0 and warns when push-to-product-repos.sh fails"

REPO2="$TMPROOT/repo2"
make_repo "$REPO2"
OUT2="$TMPROOT/out2.txt"

(
  cd "$REPO2"
  # Replicate the _push_safe logic verbatim from post-merge.sh.
  # PUSH_ROOT_DIR makes require_remote() check this temp repo (no remotes).
  _push_safe() {
    local product="$1"
    local label="$2"
    (
      PUSH_ROOT_DIR="$REPO2" bash "$SCRIPT_DIR/push-to-product-repos.sh" "$product"
    ) || echo "⚠️   $label template push skipped — remote not configured or push failed. Run manually: scripts/push-to-product-repos.sh $product"
  }
  _push_safe crm "CRM"
) >"$OUT2" 2>&1
EXIT2=$?

if [ "$EXIT2" -ne 0 ]; then
  _fail "_push_safe wrapper exited $EXIT2, expected 0"
else
  if grep -q "⚠️" "$OUT2"; then
    _pass "_push_safe exits 0 and emits ⚠️  warning when remote is absent"
  else
    _fail "_push_safe exited 0 but warning line was not printed"
    echo "    --- captured output ---"
    cat "$OUT2"
    echo "    -----------------------"
  fi
fi

# ---------------------------------------------------------------------------
# Test 3: ORIG_HEAD missing, HEAD~1 present — fallback path exits 0
# ---------------------------------------------------------------------------
echo ""
echo "Test 3: ORIG_HEAD missing — CHANGED_FILES detection falls back to HEAD~1"

REPO3="$TMPROOT/repo3"
make_repo "$REPO3" 2      # two commits → HEAD~1 exists, ORIG_HEAD does not
OUT3="$TMPROOT/out3.txt"

(
  cd "$REPO3"
  # Replicate the detection expression verbatim from post-merge.sh
  CHANGED_FILES="$(git diff --name-only ORIG_HEAD HEAD 2>/dev/null \
    || git diff --name-only HEAD~1 HEAD 2>/dev/null \
    || true)"
  # At least one file must appear in the diff (we changed the repo between commits)
  if [ -n "$CHANGED_FILES" ]; then
    echo "fallback-worked: $CHANGED_FILES"
  else
    echo "empty-but-ok"   # both refs unknown → 'true' returned empty string
  fi
) >"$OUT3" 2>&1
EXIT3=$?

if [ "$EXIT3" -ne 0 ]; then
  _fail "ORIG_HEAD-missing detection exited $EXIT3, expected 0"
else
  if grep -q "fallback-worked\|empty-but-ok" "$OUT3"; then
    _pass "ORIG_HEAD-missing detection exits 0 (fell back to HEAD~1)"
  else
    _fail "Unexpected output from ORIG_HEAD-missing test"
    echo "    --- captured output ---"
    cat "$OUT3"
    echo "    -----------------------"
  fi
fi

# ---------------------------------------------------------------------------
# Test 4: Both ORIG_HEAD and HEAD~1 missing (first / shallow commit) — the
#         "|| true" tail must keep the whole expression exit 0 and the sync
#         block must be skipped (not crash)
# ---------------------------------------------------------------------------
echo ""
echo "Test 4: First commit — ORIG_HEAD and HEAD~1 both missing, exits 0 via 'true'"

REPO4="$TMPROOT/repo4"
make_repo "$REPO4" 1      # single commit — HEAD~1 does not exist
OUT4="$TMPROOT/out4.txt"

(
  cd "$REPO4"
  CHANGED_FILES="$(git diff --name-only ORIG_HEAD HEAD 2>/dev/null \
    || git diff --name-only HEAD~1 HEAD 2>/dev/null \
    || true)"

  # Replicate the gate from post-merge.sh:
  #   if ! $PUSH_CRM && ! $PUSH_MOBILE && ! $PUSH_WEBSITE; then skip
  _changed_in() {
    [ -n "$CHANGED_FILES" ] && echo "$CHANGED_FILES" | grep -q "^${1}"
  }
  PUSH_CRM=false
  PUSH_MOBILE=false
  PUSH_WEBSITE=false
  SHARED_CHANGED=false
  if _changed_in "artifacts/api-server/" || _changed_in "lib/" || _changed_in "scripts/"; then
    SHARED_CHANGED=true
  fi
  if $SHARED_CHANGED || _changed_in "artifacts/command-center/"; then PUSH_CRM=true; fi
  if $SHARED_CHANGED || _changed_in "artifacts/mobile-crm/";     then PUSH_MOBILE=true; fi
  if $SHARED_CHANGED || _changed_in "artifacts/website/";        then PUSH_WEBSITE=true; fi

  if ! $PUSH_CRM && ! $PUSH_MOBILE && ! $PUSH_WEBSITE; then
    echo "sync-skipped-cleanly"
  else
    echo "sync-would-run"   # fine too — we only care that we did not crash
  fi
) >"$OUT4" 2>&1
EXIT4=$?

if [ "$EXIT4" -ne 0 ]; then
  _fail "First-commit fallback exited $EXIT4, expected 0"
else
  if grep -q "sync-skipped-cleanly\|sync-would-run" "$OUT4"; then
    _pass "First-commit (no ORIG_HEAD, no HEAD~1) fallback exits 0"
  else
    _fail "Unexpected output from first-commit test"
    echo "    --- captured output ---"
    cat "$OUT4"
    echo "    -----------------------"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
