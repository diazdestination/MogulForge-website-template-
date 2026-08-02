/**
 * Build-time SEO verification: asserts every prerendered page in dist/public
 * has the head tags search engines need. Fails the build loudly, naming the
 * broken route, instead of silently shipping pages with no head.
 *
 * Checks per page: non-empty <title>, meta description, canonical link, and
 * at least one JSON-LD block. Redirect stubs must contain their meta refresh
 * target and a canonical.
 *
 * Site-wide: sitemap.xml must exactly match listRoutes() (every route present
 * with its SITE_ORIGIN URL, no entries for non-prerendered pages), and
 * robots.txt must reference the sitemap.
 *
 * Run after prerender:  node scripts/verify-seo.mjs
 */
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(root, '../dist/public');
const serverEntry = path.resolve(root, '../dist/server/entry-server.js');

const { listRoutes, LEGACY_REDIRECTS, getBusiness } = await import(serverEntry);
const { SITE_ORIGIN } = getBusiness();

// Config-only area routes prerendered by prerender.mjs from the org site
// config (areas added via CRM site settings). Their share cards are served
// by the API rather than committed to public/.
let configRoutes = [];
try {
  configRoutes = JSON.parse(
    await readFile(path.resolve(root, '../dist/server/prerender-config-routes.json'), 'utf8'),
  );
} catch {
  // Older build without the manifest — verify static routes only.
}

/** og:image URLs the API renders at request time (no file in dist/public). */
const API_CARD_PATH = /^\/api\/v1\/public\/og\/area\/[^/]+(\.png)?$/;

const errors = [];

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function fileFor(route) {
  return route === '/' ? path.join(dist, 'index.html') : path.join(dist, route.slice(1), 'index.html');
}

async function readPage(route) {
  try {
    return await readFile(fileFor(route), 'utf8');
  } catch {
    errors.push(`${route}: prerendered file missing (${path.relative(dist, fileFor(route))})`);
    return null;
  }
}

const routes = [...listRoutes(), ...configRoutes];
if (routes.length === 0) {
  errors.push('listRoutes() returned no routes — nothing was prerendered');
}

for (const route of routes) {
  const html = await readPage(route);
  if (html === null) continue;

  const title = html.match(/<title>([\s\S]*?)<\/title>/);
  if (!title || !title[1].trim()) {
    errors.push(`${route}: missing or empty <title>`);
  }

  const desc = html.match(/<meta name="description" content="([^"]*)"/);
  if (!desc || !desc[1].trim()) {
    errors.push(`${route}: missing or empty meta description`);
  }

  const canonical = html.match(/<link rel="canonical" href="([^"]*)"/);
  if (!canonical || !canonical[1].trim()) {
    errors.push(`${route}: missing canonical link`);
  } else if (!canonical[1].startsWith(SITE_ORIGIN)) {
    errors.push(`${route}: canonical "${canonical[1]}" does not start with site origin ${SITE_ORIGIN}`);
  }

  if (!/<script type="application\/ld\+json">\s*\{[\s\S]*?\}\s*<\/script>/.test(html)) {
    errors.push(`${route}: no JSON-LD structured data block`);
  }

  // Social share images: og:image / twitter:image must point at files that exist.
  for (const [tag, re] of [
    ['og:image', /<meta property="og:image" content="([^"]*)"/],
    ['twitter:image', /<meta name="twitter:image" content="([^"]*)"/],
  ]) {
    const m = html.match(re);
    if (!m || !m[1].trim()) {
      errors.push(`${route}: missing or empty ${tag}`);
      continue;
    }
    const url = m[1];
    if (!url.startsWith(SITE_ORIGIN)) {
      errors.push(`${route}: ${tag} "${url}" does not start with site origin ${SITE_ORIGIN}`);
      continue;
    }
    const imagePath = decodeURIComponent(new URL(url).pathname);
    const file = path.join(dist, imagePath.replace(/^\//, ''));
    if (API_CARD_PATH.test(imagePath)) {
      // Server-rendered area card — nothing to check on disk.
    } else if (!(await exists(file))) {
      errors.push(
        `${route}: ${tag} points at "${url}" but ${path.relative(dist, file)} does not exist in dist/public — link previews would be broken`,
      );
    }
    // Area pages must have their own share card, never the generic fallback.
    // A new area in src/content/areas.ts gets its card from
    // scripts/generate-og-images.mjs; catch it here if that step was skipped.
    if (/^\/service-areas\/[^/]+$/.test(route) && imagePath === '/og-default.png') {
      errors.push(
        `${route}: ${tag} uses the generic og-default.png — run "node scripts/generate-og-images.mjs" to create og-area-<slug>.png for this area`,
      );
    }
  }
}

// Redirect stubs: meta refresh must point at the redirect target.
for (const { from, to } of LEGACY_REDIRECTS) {
  if (from === to) continue;
  const html = await readPage(from);
  if (html === null) continue;

  const refresh = html.match(/<meta http-equiv="refresh" content="0;url=([^"]*)"/);
  if (!refresh) {
    errors.push(`${from}: redirect stub missing meta refresh`);
  } else if (refresh[1] !== to) {
    errors.push(`${from}: meta refresh points at "${refresh[1]}", expected "${to}"`);
  }

  if (!html.includes(`<link rel="canonical" href="${SITE_ORIGIN}${to}"`)) {
    errors.push(`${from}: redirect stub missing canonical to ${SITE_ORIGIN}${to}`);
  }
}

// Hosting rewrites: the static production host serves files literally (no
// directory-index resolution), so every prerendered route needs an explicit
// non-trailing-slash rewrite in artifact.toml (from "/foo" to
// "/foo/index.html") ahead of the SPA catch-all — otherwise /foo serves the
// homepage with the homepage's canonical tag.
//
// Only the static code-defined routes (listRoutes()) are enforced here:
// config-only area routes come from CRM site settings at build time, so
// artifact.toml cannot predeclare them. Their canonical trailing-slash URLs
// (the only form in the sitemap) still serve correctly; a rewrite may be
// added for them when known, and is accepted below.
{
  const tomlPath = path.resolve(root, '../.replit-artifact/artifact.toml');
  let toml = null;
  try {
    toml = await readFile(tomlPath, 'utf8');
  } catch {
    errors.push('artifact.toml: missing — cannot verify production rewrites');
  }
  if (toml !== null) {
    const rewrites = [...toml.matchAll(/\[\[services\.production\.rewrites\]\]\s*\nfrom = "([^"]*)"\s*\nto = "([^"]*)"/g)]
      .map((m) => ({ from: m[1], to: m[2] }));
    const catchAllIndex = rewrites.findIndex((r) => r.from === '/*');
    if (catchAllIndex === -1) {
      errors.push('artifact.toml: missing SPA catch-all rewrite (from "/*" to "/index.html")');
    }
    for (const route of listRoutes()) {
      if (route === '/') continue;
      const idx = rewrites.findIndex((r) => r.from === route && r.to === `${route}/index.html`);
      if (idx === -1) {
        errors.push(
          `artifact.toml: missing rewrite for ${route} (from "${route}" to "${route}/index.html") — without it the non-trailing-slash URL serves the homepage in production. Run "node scripts/generate-rewrites.mjs" and apply the generated artifact.rewrites.toml via the artifact.toml validation flow.`,
        );
      } else if (catchAllIndex !== -1 && idx > catchAllIndex) {
        errors.push(`artifact.toml: rewrite for ${route} appears after the "/*" catch-all and would never match`);
      }
    }
    for (const r of rewrites) {
      if (r.from !== '/*' && !routes.includes(r.from)) {
        errors.push(
          `artifact.toml: rewrite for ${r.from} does not match any prerendered route (removed page?) — regenerate with "node scripts/generate-rewrites.mjs"`,
        );
      }
    }
  }
}

// Sitemap: must exactly match listRoutes() with SITE_ORIGIN URLs.
{
  let sitemap = null;
  try {
    sitemap = await readFile(path.join(dist, 'sitemap.xml'), 'utf8');
  } catch {
    errors.push('sitemap.xml: missing from dist/public');
  }
  if (sitemap !== null) {
    const locs = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1].trim());
    const expected = new Set(routes.map((r) => (r === '/' ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}${r}`)));
    const seen = new Set();
    for (const loc of locs) {
      if (seen.has(loc)) errors.push(`sitemap.xml: duplicate entry ${loc}`);
      seen.add(loc);
      if (!expected.has(loc)) {
        errors.push(`sitemap.xml: entry ${loc} does not match any prerendered route (removed page or wrong origin?)`);
      }
    }
    for (const url of expected) {
      if (!seen.has(url)) {
        const route = url.slice(SITE_ORIGIN.length) || '/';
        errors.push(`sitemap.xml: missing entry for prerendered route ${route} (expected ${url})`);
      }
    }
  }
}

// robots.txt: must exist and reference the sitemap by its SITE_ORIGIN URL.
{
  let robots = null;
  try {
    robots = await readFile(path.join(dist, 'robots.txt'), 'utf8');
  } catch {
    errors.push('robots.txt: missing from dist/public');
  }
  if (robots !== null) {
    const sitemapLines = robots
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^sitemap:/i.test(l))
      .map((l) => l.replace(/^sitemap:\s*/i, ''));
    const expectedSitemapUrl = `${SITE_ORIGIN}/sitemap.xml`;
    if (sitemapLines.length === 0) {
      errors.push(`robots.txt: no Sitemap: line (expected "Sitemap: ${expectedSitemapUrl}")`);
    } else if (!sitemapLines.includes(expectedSitemapUrl)) {
      errors.push(`robots.txt: Sitemap points at "${sitemapLines.join('", "')}", expected ${expectedSitemapUrl}`);
    }
  }
}

if (errors.length > 0) {
  console.error(`SEO verification FAILED (${errors.length} problem${errors.length === 1 ? '' : 's'}):`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error('Fix the routes above (usually a missing/renamed <Seo> block or a prerender change).');
  process.exit(1);
}

const stubCount = LEGACY_REDIRECTS.filter(({ from, to }) => from !== to).length;
console.log(`SEO verification passed: ${routes.length} pages + ${stubCount} redirect stubs OK; sitemap.xml and robots.txt match`);
