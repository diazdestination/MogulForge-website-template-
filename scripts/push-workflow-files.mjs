#!/usr/bin/env node
/**
 * push-workflow-files.mjs
 *
 * Pushes .github/workflows/sync-from-upstream.yml to the website template
 * repository using a GitHub Personal Access Token that has the `workflow` scope.
 *
 * The Replit GitHub OAuth connector only has `repo` scope; GitHub's API rejects
 * writes to .github/workflows/ paths without `workflow` scope.  This script uses
 * a separate PAT (GITHUB_WORKFLOW_PAT env var) exclusively for that purpose.
 *
 * Usage:
 *   GITHUB_WORKFLOW_PAT=<token> node scripts/push-workflow-files.mjs
 *
 * Or explicitly naming the product:
 *   GITHUB_WORKFLOW_PAT=<token> node scripts/push-workflow-files.mjs website
 */

const PAT = process.env.GITHUB_WORKFLOW_PAT;
if (!PAT) {
  console.error(
    "❌  GITHUB_WORKFLOW_PAT is not set.\n" +
      "    Create a GitHub Personal Access Token with the 'workflow' scope and\n" +
      "    store it as the GITHUB_WORKFLOW_PAT Replit secret.",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Template repos
// ---------------------------------------------------------------------------
const PRODUCTS = {
  website: {
    owner: "diazdestination",
    repo: "MogulForge-website-template-",
    product: "website",
    remote: "website-template",
  },
};

const arg = process.argv[2];
const targets = arg
  ? [PRODUCTS[arg]].filter(Boolean)
  : Object.values(PRODUCTS);

if (arg && targets.length === 0) {
  console.error(
    `❌  Unknown product '${arg}'. Choose: website`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Generate the workflow YAML for a given product
// ---------------------------------------------------------------------------
function workflowContent(product, remote) {
  return `# Sync this template repo with the latest upstream monorepo.
#
# How to use
# ----------
# 1. Add a secret named MONOREPO_URL to this repository's Settings → Secrets
#    that contains the HTTPS clone URL of your upstream monorepo
#    (e.g. https://<token>@github.com/YOUR_ORG/painless-growthos.git).
# 2. Go to Actions → "Sync from upstream monorepo" → Run workflow.
#
# The workflow clones the monorepo, runs the export script for this product,
# and force-pushes the result back to this repository's main branch — exactly
# as if you had run  scripts/push-to-product-repos.sh ${product}  locally.
name: Sync from upstream monorepo

on:
  workflow_dispatch:
    inputs:
      monorepo_url:
        description: >
          HTTPS clone URL of the upstream monorepo.
          Leave blank to use the MONOREPO_URL repository secret.
        required: false
        type: string

jobs:
  sync:
    name: Export & push ${product} template
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
          git remote remove ${remote} 2>/dev/null || true
          git remote add ${remote} \\
            "https://x-access-token:\${{ secrets.GITHUB_TOKEN }}@github.com/\${{ github.repository }}.git"

      - name: Configure git identity
        run: |
          git config --global user.email "template-sync@painless-growthos"
          git config --global user.name "Template Sync"

      - name: Run export and push
        run: |
          cd monorepo
          bash scripts/push-to-product-repos.sh ${product}
`;
}

// ---------------------------------------------------------------------------
// GitHub Contents API helpers
// ---------------------------------------------------------------------------
async function ghGet(owner, repo, path) {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    {
      headers: {
        Authorization: `Bearer ${PAT}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `GET /repos/${owner}/${repo}/contents/${path} → HTTP ${res.status}: ${text.slice(0, 300)}`,
    );
  }
  return res.json();
}

async function ghPut(owner, repo, path, content, sha, message) {
  const body = {
    message,
    content: Buffer.from(content).toString("base64"),
    branch: "main",
  };
  if (sha) body.sha = sha; // required when updating an existing file

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${PAT}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `PUT /repos/${owner}/${repo}/contents/${path} → HTTP ${res.status}: ${text.slice(0, 300)}`,
    );
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const WORKFLOW_PATH = ".github/workflows/sync-from-upstream.yml";

(async () => {
  for (const { owner, repo, product, remote } of targets) {
    process.stdout.write(
      `ℹ️   ${owner}/${repo} — pushing ${WORKFLOW_PATH} … `,
    );

    const content = workflowContent(product, remote);

    // Check if the file already exists (need its SHA to update it)
    const existing = await ghGet(owner, repo, WORKFLOW_PATH);
    const sha = existing?.sha ?? undefined;
    const verb = sha ? "Update" : "Add";

    await ghPut(
      owner,
      repo,
      WORKFLOW_PATH,
      content,
      sha,
      `ci: ${verb} sync-from-upstream workflow`,
    );

    console.log(`✅  ${verb === "Add" ? "created" : "updated"}`);
  }

  console.log("\n✅  Done — workflow file committed to website template repo.");
})().catch((err) => {
  console.error(`❌  ${err.message}`);
  process.exit(1);
});
