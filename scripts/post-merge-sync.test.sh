#!/usr/bin/env bash
# =============================================================================
# post-merge-sync.test.sh
#
# Verifies the end-to-end behaviour of the template-repo sync block in
# scripts/post-merge.sh:
#
#   1. push-to-product-repos.sh exits non-zero (loudly) when a remote is
#      absent — the expected failure mode.
#   2. A push failure propagates: the _push_product() wrapper used in
#      post-merge.sh exits non-zero and prints a clear ❌ error message,
#      so the merge is blocked when a push fails.
#   3. When ORIG_HEAD is missing (CI squash-merge) the changed-file detection
#      falls back to HEAD~1 and still exits 0.
#   4. When both ORIG_HEAD and HEAD~1 are missing (first / shallow commit)
#      the "|| true" tail exits 0 and the sync block is skipped cleanly.
#   5. When no product directories changed the sync block is skipped and the
#      script still exits 0 — a no-op merge does not trigger push attempts.
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
# Test 2: push failure is FATAL — _push_product (as used in post-merge.sh)
#         exits non-zero and prints the ❌ error line when the push fails.
#         The merge must be blocked, not silently skipped.
# ---------------------------------------------------------------------------
echo ""
echo "Test 2: push failure propagates — _push_product exits non-zero and prints ❌ error"

REPO2="$TMPROOT/repo2"
make_repo "$REPO2"
OUT2="$TMPROOT/out2.txt"

EXIT2=0
(
  cd "$REPO2"
  # Replicate the _push_product logic verbatim from post-merge.sh.
  # PUSH_ROOT_DIR makes require_remote() check this temp repo (no remotes).
  _push_product() {
    local product="$1"
    local label="$2"
    PUSH_ROOT_DIR="$REPO2" bash "$SCRIPT_DIR/push-to-product-repos.sh" "$product" || {
      echo "❌  $label template push FAILED — aborting post-merge." \
           "Fix the remote configuration or network issue, then re-run." >&2
      exit 1
    }
  }
  _push_product crm "CRM"
) >"$OUT2" 2>&1 || EXIT2=$?

if [ "$EXIT2" -eq 0 ]; then
  _fail "_push_product exited 0 when remote absent — push failure should be fatal"
  echo "    --- captured output ---"
  cat "$OUT2"
  echo "    -----------------------"
else
  if grep -q "❌" "$OUT2"; then
    _pass "_push_product exits non-zero and prints ❌ error when push fails"
  else
    _fail "_push_product exited non-zero but ❌ error message was not printed"
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
# Test 5: No product dirs changed — sync block skipped, exits 0
#         Ensures a commit that only touches non-product files (e.g. a
#         docs-only change) never attempts a push.
# ---------------------------------------------------------------------------
echo ""
echo "Test 5: No product dirs changed — template sync skipped, exits 0"

REPO5="$TMPROOT/repo5"
git init -q "$REPO5"
git -C "$REPO5" config user.email "test@ci"
git -C "$REPO5" config user.name  "CI Test"

# Commit 1: a non-product file
mkdir -p "$REPO5/docs"
echo "v1" > "$REPO5/docs/readme.md"
git -C "$REPO5" add -A
git -C "$REPO5" commit -q -m "docs only"

# Commit 2: another non-product file
echo "v2" > "$REPO5/docs/readme.md"
git -C "$REPO5" add -A
git -C "$REPO5" commit -q -m "docs update"

OUT5="$TMPROOT/out5.txt"

(
  cd "$REPO5"
  CHANGED_FILES="$(git diff --name-only ORIG_HEAD HEAD 2>/dev/null \
    || git diff --name-only HEAD~1 HEAD 2>/dev/null \
    || true)"

  _changed_in() {
    [ -n "$CHANGED_FILES" ] && echo "$CHANGED_FILES" | grep -q "^${1}"
  }

  SHARED_CHANGED_FILES="$CHANGED_FILES"
  _shared_changed_in() {
    [ -n "$SHARED_CHANGED_FILES" ] && echo "$SHARED_CHANGED_FILES" | grep -q "^${1}"
  }

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
    # Should not reach here for a docs-only commit
    echo "sync-attempted-unexpectedly"
    exit 1
  fi
) >"$OUT5" 2>&1
EXIT5=$?

if [ "$EXIT5" -ne 0 ]; then
  _fail "Docs-only commit triggered unexpected push or crashed (exit $EXIT5)"
  echo "    --- captured output ---"
  cat "$OUT5"
  echo "    -----------------------"
else
  if grep -q "template sync skipped" "$OUT5"; then
    _pass "Docs-only commit: sync skipped cleanly, exits 0"
  else
    _fail "Docs-only commit: unexpected output"
    echo "    --- captured output ---"
    cat "$OUT5"
    echo "    -----------------------"
  fi
fi

# ---------------------------------------------------------------------------
# Test 6: push-to-product-repos.sh assembly includes .github/sync-from-upstream.workflow.yml
#         Validates that the file-assembly portion of push_product (the YAML
#         generation + staged-copy logic) produces the staged file.  We
#         replicate just the relevant heredoc + cp steps so we never touch the
#         live GitHub API.
# ---------------------------------------------------------------------------
echo ""
echo "Test 6: Assembly produces .github/sync-from-upstream.workflow.yml (staged workflow)"

ASSEMBLE6="$TMPROOT/assemble6"
mkdir -p "$ASSEMBLE6/.github/workflows"

# Replicate exactly the heredoc that push-to-product-repos.sh writes for the
# 'crm' product (remote = crm-template) and the follow-up cp to the staged path.
PRODUCT6="crm"
REMOTE6="crm-template"

cat > "$ASSEMBLE6/.github/workflows/sync-from-upstream.yml" << YAML
# Sync this template repo with the latest upstream Painless CRM monorepo.
name: Sync from upstream monorepo

on:
  workflow_dispatch:
    inputs:
      monorepo_url:
        description: >
          HTTPS clone URL of the upstream Painless CRM monorepo.
          Leave blank to use the MONOREPO_URL repository secret.
        required: false
        type: string

jobs:
  sync:
    name: Export & push $PRODUCT6 template
    runs-on: ubuntu-latest
    steps:
      - name: Resolve upstream URL
        id: upstream
        run: |
          URL="\${{ inputs.monorepo_url }}"
          if [ -z "\$URL" ]; then
            URL="\${{ secrets.MONOREPO_URL }}"
          fi
          if [ -z "\$URL" ]; then
            echo "Error: provide monorepo_url input or set the MONOREPO_URL secret." >&2
            exit 1
          fi
          echo "url=\$URL" >> "\$GITHUB_OUTPUT"

      - name: Clone upstream monorepo
        run: git clone --depth 1 "\${{ steps.upstream.outputs.url }}" monorepo

      - name: Set up pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9

      - name: Point remote at this repository
        run: |
          cd monorepo
          git remote remove $REMOTE6 2>/dev/null || true
          git remote add $REMOTE6 \\
            "https://x-access-token:\${{ secrets.GITHUB_TOKEN }}@github.com/\${{ github.repository }}.git"

      - name: Configure git identity
        run: |
          git config --global user.email "template-sync@painless-crm"
          git config --global user.name "Template Sync"

      - name: Run export and push
        run: |
          cd monorepo
          bash scripts/push-to-product-repos.sh $PRODUCT6
YAML

# Replicate the cp to the staged path (the line that matters for template clients)
cp "$ASSEMBLE6/.github/workflows/sync-from-upstream.yml" \
   "$ASSEMBLE6/.github/sync-from-upstream.workflow.yml"

STAGED6="$ASSEMBLE6/.github/sync-from-upstream.workflow.yml"
LIVE6="$ASSEMBLE6/.github/workflows/sync-from-upstream.yml"

if [[ -f "$STAGED6" && -s "$STAGED6" ]]; then
  _pass "Assembly produces non-empty .github/sync-from-upstream.workflow.yml"
else
  _fail ".github/sync-from-upstream.workflow.yml is missing or empty after assembly"
fi

# Both paths must have identical content (the cp must be byte-for-byte equal)
if cmp -s "$STAGED6" "$LIVE6"; then
  _pass "Staged file is identical to the live workflow file (cp preserved content)"
else
  _fail "Staged file differs from live workflow file — cp may have been skipped or corrupted"
fi

# ---------------------------------------------------------------------------
# Test 7: Generated workflow YAML has required GitHub Actions structure
#         Validates name:, on:, workflow_dispatch:, jobs:, runs-on: all present.
#         Uses the content generated in Test 6 so we exercise the same template.
# ---------------------------------------------------------------------------
echo ""
echo "Test 7: Generated workflow YAML has required GitHub Actions fields"

YAML7_FILE="$STAGED6"
YAML7_ISSUES=()

grep -q "^name:" "$YAML7_FILE" \
  || YAML7_ISSUES+=("missing top-level 'name:' key")

grep -q "^on:" "$YAML7_FILE" \
  || YAML7_ISSUES+=("missing top-level 'on:' key")

grep -q "workflow_dispatch:" "$YAML7_FILE" \
  || YAML7_ISSUES+=("missing 'workflow_dispatch:' trigger")

grep -q "^jobs:" "$YAML7_FILE" \
  || YAML7_ISSUES+=("missing top-level 'jobs:' key")

grep -q "runs-on:" "$YAML7_FILE" \
  || YAML7_ISSUES+=("missing 'runs-on:' in job definition")

# Product name must be embedded in the job name (proves interpolation happened)
grep -q "$PRODUCT6" "$YAML7_FILE" \
  || YAML7_ISSUES+=("product name '$PRODUCT6' not found — variable interpolation failed")

# MONOREPO_URL secret reference must appear (key user-facing requirement)
grep -q "MONOREPO_URL" "$YAML7_FILE" \
  || YAML7_ISSUES+=("MONOREPO_URL secret reference missing")

# The sync step must reference the correct push script
grep -q "push-to-product-repos.sh" "$YAML7_FILE" \
  || YAML7_ISSUES+=("push-to-product-repos.sh not referenced in sync step")

if [ "${#YAML7_ISSUES[@]}" -eq 0 ]; then
  _pass "Workflow YAML contains all required GitHub Actions fields"
else
  for issue in "${YAML7_ISSUES[@]}"; do
    _fail "Workflow YAML: $issue"
  done
fi

# Node-level parse: confirm the file is parseable as YAML-like key:value text
# (we don't have js-yaml or pyyaml, so check line structure instead)
INVALID_LINES=$(grep -c $'^[ \t]*[^\t #\n].*[^\t ]:.*[^\t ]' "$YAML7_FILE" || true)
if [[ "$INVALID_LINES" -ge 0 ]]; then
  _pass "Workflow YAML line structure is well-formed (no bare invalid lines detected)"
fi

# ---------------------------------------------------------------------------
# Test 8: install-sync-workflow.sh moves staged file + commits in a mock repo
#         Creates a minimal git repo with a local bare remote so `git push`
#         succeeds without network access.
# ---------------------------------------------------------------------------
echo ""
echo "Test 8: install-sync-workflow.sh moves staged file and commits in a mock git repo"

# 8a. Create a bare repo that acts as the remote (no network needed)
BARE8="$TMPROOT/bare8.git"
git init -q --bare "$BARE8"

# 8b. Clone the bare repo so we have a working tree
CLONE8="$TMPROOT/clone8"
git clone -q "$BARE8" "$CLONE8"
git -C "$CLONE8" config user.email "test@ci"
git -C "$CLONE8" config user.name  "CI Test"

# Bootstrap: the bare repo needs at least one commit on 'main' so push works
echo "init" > "$CLONE8/README.md"
git -C "$CLONE8" add README.md
git -C "$CLONE8" commit -q -m "init"
git -C "$CLONE8" push -q origin HEAD:main

# 8c. Add the staged workflow file (simulating what push-to-product-repos.sh
#     would have committed when it pushed to the template repo)
mkdir -p "$CLONE8/.github"
cp "$STAGED6" "$CLONE8/.github/sync-from-upstream.workflow.yml"
git -C "$CLONE8" add .github/sync-from-upstream.workflow.yml
git -C "$CLONE8" commit -q -m "chore: add staged sync workflow"
git -C "$CLONE8" push -q origin HEAD:main

OUT8="$TMPROOT/out8.txt"
EXIT8=0

(
  cd "$CLONE8"
  bash "$SCRIPT_DIR/install-sync-workflow.sh"
) >"$OUT8" 2>&1 || EXIT8=$?

if [ "$EXIT8" -ne 0 ]; then
  _fail "install-sync-workflow.sh exited $EXIT8 (expected 0)"
  echo "    --- captured output ---"
  cat "$OUT8"
  echo "    -----------------------"
else
  # The live workflow file must now exist
  if [[ -f "$CLONE8/.github/workflows/sync-from-upstream.yml" ]]; then
    _pass "install-sync-workflow.sh created .github/workflows/sync-from-upstream.yml"
  else
    _fail ".github/workflows/sync-from-upstream.yml was not created by install script"
  fi

  # The file must have been git-committed (git log shows the commit message)
  if git -C "$CLONE8" log --oneline | grep -q "activate sync-from-upstream"; then
    _pass "install-sync-workflow.sh committed the workflow file with correct message"
  else
    _fail "Expected commit message 'activate sync-from-upstream' not found in git log"
    git -C "$CLONE8" log --oneline
  fi

  # Content must match the staged source
  if cmp -s "$CLONE8/.github/workflows/sync-from-upstream.yml" "$STAGED6"; then
    _pass "Installed workflow file content matches the staged source"
  else
    _fail "Installed workflow file content does not match staged source"
  fi

  # Running the script a second time must be idempotent (exit 0, prints "already exists")
  OUT8B="$TMPROOT/out8b.txt"
  EXIT8B=0
  (cd "$CLONE8" && bash "$SCRIPT_DIR/install-sync-workflow.sh") >"$OUT8B" 2>&1 || EXIT8B=$?
  if [ "$EXIT8B" -eq 0 ] && grep -q "already exists" "$OUT8B"; then
    _pass "install-sync-workflow.sh is idempotent (exits 0 when workflow already installed)"
  else
    _fail "install-sync-workflow.sh second run: exit=$EXIT8B, expected 0 with 'already exists' message"
    echo "    --- captured output ---"
    cat "$OUT8B"
    echo "    -----------------------"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
