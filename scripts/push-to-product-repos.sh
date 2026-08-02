#!/usr/bin/env bash
# =============================================================================
# push-to-product-repos.sh
#
# Assembles a standalone, rebrandable copy of one product and pushes it to its
# configured GitHub remote.
#
# Usage:
#   ./scripts/push-to-product-repos.sh [crm|mobile|website|all]
#
# Before your first push you must point each remote at a real GitHub repo:
#   git remote set-url crm-template    https://github.com/YOUR_ORG/crm-template.git
#   git remote set-url mobile-template https://github.com/YOUR_ORG/mobile-template.git
#   git remote set-url website-template https://github.com/YOUR_ORG/website-template.git
#
# What each product repo contains:
#   crm      → artifacts/command-center + artifacts/api-server + lib/*
#   mobile   → artifacts/mobile-crm     + artifacts/api-server + lib/*
#   website  → artifacts/website        + artifacts/api-server + lib/*
#
# The repo is built in a temp directory, committed, and force-pushed. Every
# push is idempotent — running it again just updates the remote to match HEAD.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Allow tests to override ROOT_DIR so require_remote() inspects a temp repo
# instead of the live workspace.  Production callers never set this variable.
ROOT_DIR="${PUSH_ROOT_DIR:-$(dirname "$SCRIPT_DIR")}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

die() { echo "❌  $*" >&2; exit 1; }
info() { echo "ℹ️   $*"; }
ok()   { echo "✅  $*"; }

# Global temp-dir used by push_product so the EXIT trap (which runs in global
# scope, not function scope) can reliably clean up even on error.
_PUSH_TMPDIR=""
_cleanup_tmpdir() {
  if [[ -n "${_PUSH_TMPDIR:-}" ]]; then
    rm -rf "$_PUSH_TMPDIR"
    _PUSH_TMPDIR=""
  fi
}
trap _cleanup_tmpdir EXIT

require_remote() {
  local name="$1"
  local url
  url="$(git -C "$ROOT_DIR" remote get-url "$name" 2>/dev/null || true)"
  if [[ -z "$url" || "$url" == *"OWNER"* || "$url" == *"placeholder"* ]]; then
    die "Remote '$name' is not configured. Run:\n  git remote set-url $name https://github.com/YOUR_ORG/REPO.git"
  fi
  echo "$url"
}

# Packages always included (shared libs + api-server)
SHARED_DIRS=(
  "artifacts/api-server"
  "lib"
  "scripts"
)

# Root-level files to copy into the product repo
ROOT_FILES=(
  "package.json"
  "pnpm-workspace.yaml"
  "tsconfig.json"
  ".npmrc"
  ".gitignore"
)

# ---------------------------------------------------------------------------
# push_product <product_slug> <artifact_dir> <remote_name>
# ---------------------------------------------------------------------------
push_product() {
  local product="$1"
  local artifact="$2"
  local remote="$3"

  local remote_url
  remote_url="$(require_remote "$remote")"
  info "Pushing '$product' → $remote_url"

  # Build in a temp directory (use global so the EXIT trap can reach it)
  _PUSH_TMPDIR="$(mktemp -d)"
  local tmpdir="$_PUSH_TMPDIR"

  info "Assembling product in $tmpdir …"

  # Copy artifact — use tar to exclude generated/installed dirs (rsync not
  # available in NixOS; tar with --exclude is portable and equivalent)
  mkdir -p "$tmpdir/artifacts"
  tar -C "$ROOT_DIR" \
    --exclude='node_modules' --exclude='dist' --exclude='.expo' \
    -cf - "artifacts/$artifact" | tar -xf - -C "$tmpdir"

  # Copy shared dirs
  for dir in "${SHARED_DIRS[@]}"; do
    if [[ -d "$ROOT_DIR/$dir" ]]; then
      tar -C "$ROOT_DIR" \
        --exclude='node_modules' --exclude='dist' \
        -cf - "$dir" | tar -xf - -C "$tmpdir"
    fi
  done

  # Copy root config files
  for f in "${ROOT_FILES[@]}"; do
    if [[ -f "$ROOT_DIR/$f" ]]; then
      cp "$ROOT_DIR/$f" "$tmpdir/$f"
    fi
  done

  # Rewrite pnpm-workspace.yaml to only list the included artifacts
  cat > "$tmpdir/pnpm-workspace.yaml" << YAML
packages:
  - artifacts/api-server
  - artifacts/$artifact
  - lib/*
  - lib/integrations/*
  - scripts

autoInstallPeers: false
YAML
  # Append catalog + overrides from the original workspace file (everything
  # after the packages block) so version pins are preserved.
  awk '/^catalog:/,0' "$ROOT_DIR/pnpm-workspace.yaml" >> "$tmpdir/pnpm-workspace.yaml"

  # Copy the product-specific README as the repo root README
  local readme_src="$ROOT_DIR/artifacts/$artifact/README-template.md"
  if [[ -f "$readme_src" ]]; then
    cp "$readme_src" "$tmpdir/README.md"
  fi

  # Bundle a GitHub Actions workflow so template-repo owners can trigger a
  # resync from GitHub without touching the monorepo locally.
  mkdir -p "$tmpdir/.github/workflows"
  cat > "$tmpdir/.github/workflows/sync-from-upstream.yml" << YAML
# Sync this template repo with the latest upstream Painless CRM monorepo.
#
# How to use
# ----------
# 1. Add a secret named MONOREPO_URL to this repository's Settings → Secrets
#    that contains the HTTPS clone URL of your upstream Painless CRM monorepo
#    (e.g. https://<token>@github.com/YOUR_ORG/painless-crm.git).
# 2. Go to Actions → "Sync from upstream monorepo" → Run workflow.
#
# The workflow clones the monorepo, runs the export script for this product,
# and force-pushes the result back to this repository's main branch — exactly
# as if you had run  scripts/push-to-product-repos.sh $product  locally.
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
    name: Export & push $product template
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
          # Add (or update) the remote that push-to-product-repos.sh uses for
          # this product, pointing it at the current template repo.
          git remote remove $remote 2>/dev/null || true
          git remote add $remote \\
            "https://x-access-token:\${{ secrets.GITHUB_TOKEN }}@github.com/\${{ github.repository }}.git"

      - name: Configure git identity
        run: |
          git config --global user.email "template-sync@painless-crm"
          git config --global user.name "Template Sync"

      - name: Run export and push
        run: |
          cd monorepo
          bash scripts/push-to-product-repos.sh $product
YAML

  info "Bundled .github/workflows/sync-from-upstream.yml into $product template"

  # Also write the workflow to a staging path that the Replit connector CAN push
  # (GitHub's Trees API rejects .github/workflows/ without `workflow` scope, but
  # accepts any other path under .github/).  Template users activate it by running
  # scripts/install-sync-workflow.sh from a local clone — a plain `git push` does
  # NOT require `workflow` scope.
  cp "$tmpdir/.github/workflows/sync-from-upstream.yml" \
     "$tmpdir/.github/sync-from-upstream.workflow.yml"
  info "Staged workflow at .github/sync-from-upstream.workflow.yml (activation: scripts/install-sync-workflow.sh)"

  # Push via GitHub API (uses Replit OAuth connection — no PAT needed)
  local commit_msg="chore: sync from monorepo [$(date -u +%Y-%m-%dT%H:%M:%SZ)]"
  local gh_owner gh_repo
  gh_owner="$(echo "$remote_url" | sed -E 's|https://github\.com/([^/]+)/.*|\1|')"
  gh_repo="$(echo "$remote_url" | sed -E 's|.*/||' | sed 's/\.git$//')"
  info "Pushing '$product' → github.com/${gh_owner}/${gh_repo} …"
  node "$SCRIPT_DIR/github-api-push.mjs" "$gh_owner" "$gh_repo" "$tmpdir" "$commit_msg"

  ok "'$product' pushed to $remote_url"
  _cleanup_tmpdir

  # Push the GitHub Actions workflow file separately.
  # The Replit connector only has 'repo' scope; GitHub rejects writes to
  # .github/workflows/ without 'workflow' scope.  A dedicated PAT stored as
  # GITHUB_WORKFLOW_PAT handles this single path.
  if [[ -n "${GITHUB_WORKFLOW_PAT:-}" ]]; then
    info "Pushing .github/workflows/sync-from-upstream.yml to ${gh_owner}/${gh_repo} …"
    GITHUB_WORKFLOW_PAT="$GITHUB_WORKFLOW_PAT" \
      node "$SCRIPT_DIR/push-workflow-files.mjs" "$product"
  else
    echo "⚠️   GITHUB_WORKFLOW_PAT not set — skipping .github/workflows/sync-from-upstream.yml" >&2
    echo "    Run: GITHUB_WORKFLOW_PAT=<token> node scripts/push-workflow-files.mjs $product" >&2
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
PRODUCT="${1:-all}"

case "$PRODUCT" in
  crm)
    push_product "crm" "command-center" "crm-template"
    ;;
  mobile)
    push_product "mobile" "mobile-crm" "mobile-template"
    ;;
  website)
    push_product "website" "website" "website-template"
    ;;
  all)
    push_product "crm"     "command-center" "crm-template"
    push_product "mobile"  "mobile-crm"     "mobile-template"
    push_product "website" "website"        "website-template"
    ;;
  *)
    die "Unknown product '$PRODUCT'. Choose: crm | mobile | website | all"
    ;;
esac

ok "Done."
