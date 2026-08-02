/**
 * Regenerates the per-route [[services.production.rewrites]] blocks in the
 * website's artifact.toml from listRoutes(), so adding a new service/city page
 * never requires hand-editing the rewrite list.
 *
 * Why the rewrites exist: the static production host serves files literally
 * (no directory-index resolution), so every prerendered route needs an
 * explicit non-trailing-slash rewrite (from "/foo" to "/foo/index.html")
 * ahead of the SPA catch-all — otherwise /foo serves the homepage.
 *
 * What it emits, in order:
 *   1. one rewrite per listRoutes() route (skipping "/")
 *   2. rewrites for config-only area routes: by default any existing
 *      config-area rewrites in the current artifact.toml are preserved; pass
 *      --config-routes-from-api to fetch them from the live public
 *      site-config API (the trustworthy source — never contains smoke-test
 *      fixture cities), or --include-config-routes to take them from the last
 *      build's dist/server/prerender-config-routes.json (only do this after a
 *      production-config build — a smoke build's manifest contains fixture
 *      cities that must not land in artifact.toml)
 *   3. the SPA catch-all (from "/*" to "/index.html"), always last
 * Everything outside the rewrite blocks is preserved byte-for-byte.
 *
 * artifact.toml must not be edited in place — changes go through the
 * validated replacement flow. So this script writes the full regenerated
 * TOML to a sibling file:
 *
 *     .replit-artifact/artifact.rewrites.toml
 *
 * and exits 0 with no file written when the current artifact.toml is already
 * up to date. To apply the generated file, ask the agent to run its
 * artifact.toml validation flow (verifyAndReplaceArtifactToml) with
 * artifact.rewrites.toml as the temp file — do not copy it over manually.
 *
 * Prerequisite: the SSR bundle (dist/server/entry-server.js) must exist —
 * run "vite build --ssr" (or the full package build) first.
 *
 * Usage:  node scripts/generate-rewrites.mjs [--check] [--config-routes-from-api | --include-config-routes]
 *   --check                    exit 1 if artifact.toml is out of date (no file written)
 *   --config-routes-from-api   source config-area rewrites from the live site-config
 *                              API (SITE_CONFIG_URL env overrides the default
 *                              SITE_ORIGIN/api/v1/public/site-config endpoint;
 *                              SITE_CONFIG_FILE reads a local JSON payload instead);
 *                              fails loudly if the config cannot be fetched
 *   --include-config-routes    source config-area rewrites from the prerender manifest
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(root, '../dist/server/entry-server.js');
const tomlPath = path.resolve(root, '../.replit-artifact/artifact.toml');
const outPath = path.resolve(root, '../.replit-artifact/artifact.rewrites.toml');
const checkOnly = process.argv.includes('--check');
const includeConfigRoutes = process.argv.includes('--include-config-routes');
const configRoutesFromApi = process.argv.includes('--config-routes-from-api');

if (includeConfigRoutes && configRoutesFromApi) {
  console.error('ERROR: pass at most one of --include-config-routes and --config-routes-from-api.');
  process.exit(1);
}

let listRoutes;
let listConfigOnlyAreaRoutes;
let getBusiness;
try {
  ({ listRoutes, listConfigOnlyAreaRoutes, getBusiness } = await import(serverEntry));
} catch (err) {
  console.error(
    `ERROR: could not load ${path.relative(process.cwd(), serverEntry)} (${err?.message ?? err}).\n` +
      'Build the SSR bundle first: pnpm --filter @workspace/website run build ' +
      '(or "vite build --ssr src/entry-server.tsx --outDir dist/server").',
  );
  process.exit(1);
}

const toml = await readFile(tomlPath, 'utf8');

// Locate the contiguous run of rewrite blocks (they sit between the
// production serve config and [services.env]).
const blockRe = /\[\[services\.production\.rewrites\]\]\s*\nfrom = "([^"]*)"\s*\nto = "([^"]*)"\s*\n?/g;
const matches = [...toml.matchAll(blockRe)];
if (matches.length === 0) {
  console.error('ERROR: artifact.toml has no [[services.production.rewrites]] blocks to replace.');
  process.exit(1);
}
const start = matches[0].index;
const last = matches[matches.length - 1];
const end = last.index + last[0].length;
const existing = matches.map((m) => ({ from: m[1], to: m[2] }));

const staticRoutes = listRoutes().filter((r) => r !== '/');
const staticSet = new Set(staticRoutes);

// Config-only area routes (added via CRM site settings) are not in
// listRoutes(). By default preserve whatever config-area rewrites were
// deliberately added to artifact.toml; with --include-config-routes, take
// them from the last build's prerender manifest instead (never do this after
// a smoke build — its fixture cities would leak into artifact.toml).
let extras = existing.map((r) => r.from).filter((f) => f !== '/*' && !staticSet.has(f));
if (configRoutesFromApi) {
  // Live site config is the trustworthy source for CRM-added city pages: it
  // reflects what production actually serves and can never contain smoke-test
  // fixture cities. Unlike prerender.mjs (which tolerates a failed fetch and
  // just skips config pages for one build), regenerating rewrites from a
  // failed fetch would silently DROP existing config-area rewrites — so any
  // fetch problem here is fatal.
  const { SITE_ORIGIN } = getBusiness();
  const url = process.env.SITE_CONFIG_URL || `${SITE_ORIGIN}/api/v1/public/site-config`;
  let siteConfig;
  try {
    if (process.env.SITE_CONFIG_FILE) {
      siteConfig = JSON.parse(await readFile(process.env.SITE_CONFIG_FILE, 'utf8'));
    } else {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      siteConfig = await res.json();
    }
  } catch (err) {
    console.error(
      `ERROR: --config-routes-from-api could not fetch the site config from ${url} ` +
        `(${err?.message ?? err}). Not regenerating rewrites from a failed fetch — that would ` +
        'drop existing config-area rewrites. Fix the API (or set SITE_CONFIG_URL) and retry.',
    );
    process.exit(1);
  }
  extras = listConfigOnlyAreaRoutes(siteConfig).filter((r) => r !== '/' && !staticSet.has(r));
} else if (includeConfigRoutes) {
  const manifestPath = path.resolve(root, '../dist/server/prerender-config-routes.json');
  let configRoutes;
  try {
    configRoutes = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (err) {
    console.error(
      `ERROR: --include-config-routes requires ${path.relative(process.cwd(), manifestPath)} ` +
        `(${err?.message ?? err}) — run the build's prerender step first.`,
    );
    process.exit(1);
  }
  extras = configRoutes.filter((r) => r !== '/' && !staticSet.has(r));
}

const block = (route) =>
  `[[services.production.rewrites]]\nfrom = "${route}"\nto = "${route}/index.html"\n`;

const generated =
  [...staticRoutes, ...extras].map(block).join('\n') +
  '\n[[services.production.rewrites]]\nfrom = "/*"\nto = "/index.html"\n\n';

const next = toml.slice(0, start) + generated + toml.slice(end);

if (next === toml) {
  console.log(
    `artifact.toml rewrites are up to date (${staticRoutes.length} static + ${extras.length} config-area routes + catch-all).`,
  );
  process.exit(0);
}

if (checkOnly) {
  console.error(
    'artifact.toml rewrites are OUT OF DATE with listRoutes(). ' +
      'Run "node scripts/generate-rewrites.mjs" and apply the generated artifact.rewrites.toml ' +
      'via the artifact.toml validation flow.',
  );
  process.exit(1);
}

await writeFile(outPath, next);
console.log(
  `Wrote ${path.relative(process.cwd(), outPath)} ` +
    `(${staticRoutes.length} static + ${extras.length} config-area routes + catch-all).\n` +
    'Apply it via the artifact.toml validation flow (verifyAndReplaceArtifactToml with this file ' +
    'as tempFilePath) — do not copy it over artifact.toml by hand.',
);
