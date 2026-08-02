/**
 * Build-time prerenderer: renders every public route to static HTML so
 * crawlers (including JS-limited AI bots) receive full page content.
 *
 * Run after `vite build` (client) and `vite build --ssr` (server bundle):
 *   node scripts/prerender.mjs
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(root, '../dist/public');
const serverEntry = path.resolve(root, '../dist/server/entry-server.js');

const { render, listRoutes, listConfigOnlyAreaRoutes, LEGACY_REDIRECTS, getBusiness } =
  await import(serverEntry);
const { SITE_ORIGIN } = getBusiness();

/**
 * Areas added only through CRM site settings live in the org site config, not
 * in src/content/areas.ts, so they are invisible to listRoutes(). Fetch the
 * live config at build time (or read a fixture via SITE_CONFIG_FILE) so those
 * pages get prerendered with per-city head tags too. Builds must not depend
 * on the API being reachable, so a failed fetch only logs a warning — the
 * static site is unchanged and config-only areas fall back to client-side
 * rendering until the next successful build.
 */
async function loadSiteConfig() {
  if (process.env.SITE_CONFIG_FILE) {
    const raw = await readFile(process.env.SITE_CONFIG_FILE, 'utf8');
    return JSON.parse(raw);
  }
  const url = process.env.SITE_CONFIG_URL || `${SITE_ORIGIN}/api/v1/public/site-config`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(
      `WARN: could not fetch site config from ${url} (${err?.message ?? err}) — ` +
        'areas added via CRM site settings will not be prerendered in this build.',
    );
    return null;
  }
}

const siteConfig = await loadSiteConfig();
const configRoutes = listConfigOnlyAreaRoutes(siteConfig);

const template = await readFile(path.join(dist, 'index.html'), 'utf8');

/** Strip shell-level title/meta/canonical that each route replaces. */
function stripHead(html) {
  return html
    .replace(/^\s*<title>[\s\S]*?<\/title>\n?/m, '')
    .replace(/^\s*<meta (?:name="(?:description|twitter:[^"]+)"|property="og:[^"]+")[^>]*>\n?/gm, '')
    .replace(/^\s*<link rel="canonical"[^>]*>\n?/gm, '');
}

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function headTags(head) {
  const lines = [
    `<title>${escapeHtml(head.title)}</title>`,
    `<meta name="description" content="${escapeHtml(head.description)}" />`,
    `<link rel="canonical" href="${head.canonical}" />`,
    `<meta property="og:title" content="${escapeHtml(head.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(head.description)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${head.canonical}" />`,
    `<meta property="og:image" content="${head.ogImage}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeHtml(head.title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(head.description)}" />`,
    `<meta name="twitter:image" content="${head.ogImage}" />`,
    ...head.jsonLd.map(
      (block) =>
        `<script type="application/ld+json">${JSON.stringify(block).replace(/</g, '\\u003c')}</script>`,
    ),
  ];
  return lines.join('\n    ');
}

async function writeRoute(route, html) {
  const outDir = route === '/' ? dist : path.join(dist, route.slice(1));
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'index.html'), html);
}

const strippedTemplate = stripHead(template);
let count = 0;

async function prerenderRoute(route, renderOptions) {
  const { html, head } = render(route, renderOptions);
  let page = strippedTemplate.replace('<div id="root"></div>', `<div id="root">${html}</div>`);
  if (head) {
    page = page.replace('</head>', `  ${headTags(head)}\n  </head>`);
  } else {
    console.error(
      `ERROR: no <Seo> head collected for ${route} — the page would ship without title/description/canonical. Add a <Seo> block to the route's page component.`,
    );
    process.exit(1);
  }
  await writeRoute(route, page);
  count += 1;
}

// Static routes render exactly as before (no config injected), so their
// output is byte-identical whether or not the config fetch succeeded.
for (const route of listRoutes()) {
  await prerenderRoute(route);
}
// Config-only area pages render with the fetched config so <Seo> emits the
// per-city title/description and the API-served share card as og:image.
for (const route of configRoutes) {
  await prerenderRoute(route, { siteConfig });
}
// Record which config-only routes were prerendered so verify-seo.mjs can
// check them (and the sitemap) without refetching the config.
await writeFile(
  path.resolve(root, '../dist/server/prerender-config-routes.json'),
  JSON.stringify(configRoutes),
);

// Legacy old-site URLs: emit canonical redirect stubs (static hosting can't 301).
for (const { from, to } of LEGACY_REDIRECTS) {
  if (from === to) continue;
  const target = `${SITE_ORIGIN}${to}`;
  const stub = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Redirecting…</title>
    <meta http-equiv="refresh" content="0;url=${to}" />
    <link rel="canonical" href="${target}" />
    <meta name="robots" content="noindex" />
  </head>
  <body>
    <p>This page has moved to <a href="${to}">${target}</a>.</p>
  </body>
</html>
`;
  await writeRoute(from, stub);
  count += 1;
}

// Generate sitemap.xml from listRoutes() so new pages are never forgotten.
// verify-seo.mjs still cross-checks it against the routes as a safety net.
const lastmod = new Date().toISOString().slice(0, 10);
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[...listRoutes(), ...configRoutes]
  .map((route) => {
    const loc = route === '/' ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}${route}`;
    return `  <url><loc>${loc}</loc><lastmod>${lastmod}</lastmod></url>`;
  })
  .join('\n')}
</urlset>
`;
await writeFile(path.join(dist, 'sitemap.xml'), sitemap);

console.log(
  `Prerendered ${count} pages into ${dist} (${configRoutes.length} from site config) ` +
    `(+ sitemap.xml with ${listRoutes().length + configRoutes.length} URLs)`,
);
