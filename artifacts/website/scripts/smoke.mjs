#!/usr/bin/env node
/**
 * Production build smoke check for the public website.
 *
 * Mirrors the seo-prerender workflow: runs the full production build
 * (client + SSR bundle + prerender + SEO verification) for both BASE_PATH
 * variants, then serves the built output and verifies the homepage HTML
 * actually responds.
 *
 *   1. Build with BASE_PATH=/site/ (the alternate mount used in preview)
 *   2. Build with BASE_PATH=/ (production root — runs last so dist/ is
 *      left in the production state, matching the workflow)
 *   3. Serve dist via `vite preview` and spot-check the homepage plus a
 *      handful of representative prerendered routes (sampled from
 *      listRoutes(), the same source as the sitemap): each must return
 *      200 with real prerendered HTML (<title>, non-empty #root) and a
 *      correct canonical + og:url pointing at the route.
 *
 * Fails loudly (non-zero exit) on any build, prerender, or serve error.
 */
import { spawn } from "node:child_process";
import { writeFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const artifactDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A site-config fixture with one config-only area (no static content, no
// committed og-area-*.png). The build must prerender it with per-city head
// tags whose og:image points at the API's server-rendered card — this is the
// crawler-visible contract for areas added via CRM site settings.
const CONFIG_ONLY_AREA = { slug: "smoke-city-ga", name: "Smoke City", state: "GA", isActive: true };
const SITE_CONFIG_FIXTURE = {
  businessProfile: {},
  services: [],
  serviceAreas: [CONFIG_ONLY_AREA],
};
const SERVE_TIMEOUT_MS = 30_000;

function run(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      cwd: artifactDir,
      env: { ...process.env, ...env },
    });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`)),
    );
    child.on("error", reject);
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// Sample up to `count` routes spread across the sitemap route list so the
// smoke check covers deeper pages (service pages, city landing pages), not
// just the homepage.
function sampleRoutes(routes, count = 5) {
  const rest = routes.filter((r) => r !== "/");
  const picked = ["/"];
  if (rest.length > 0) {
    const n = Math.min(count - 1, rest.length);
    for (let i = 0; i < n; i++) {
      picked.push(rest[Math.floor((i * rest.length) / n)]);
    }
  }
  return [...new Set(picked)];
}

async function checkRouteUrl(url, route, siteOrigin) {
  const res = await fetch(url, { redirect: "manual" });
  if (res.status !== 200) {
    throw new Error(`GET ${url} (route ${route}) returned status ${res.status}, expected 200.`);
  }
  const html = await res.text();
  const title = html.match(/<title>([\s\S]*?)<\/title>/);
  if (!title || !title[1].trim()) {
    throw new Error(`${route}: missing or empty <title> — prerender likely broken.`);
  }
  if (!html.includes('<div id="root">') || /<div id="root">\s*<\/div>/.test(html)) {
    throw new Error(`${route}: empty #root — prerendered content is missing.`);
  }
  const expectedCanonical = route === "/" ? `${siteOrigin}/` : `${siteOrigin}${route}`;
  const canonical = html.match(/<link rel="canonical" href="([^"]*)"/);
  if (!canonical || canonical[1] !== expectedCanonical) {
    throw new Error(
      `${route}: canonical is ${canonical ? `"${canonical[1]}"` : "missing"}, expected "${expectedCanonical}".`,
    );
  }
  const ogUrl = html.match(/<meta property="og:url" content="([^"]*)"/);
  if (!ogUrl || ogUrl[1] !== expectedCanonical) {
    throw new Error(
      `${route}: og:url is ${ogUrl ? `"${ogUrl[1]}"` : "missing"}, expected "${expectedCanonical}".`,
    );
  }
  const ogImage = html.match(/<meta property="og:image" content="([^"]*)"/);
  if (!ogImage || !ogImage[1].startsWith(siteOrigin)) {
    throw new Error(
      `${route}: og:image is ${ogImage ? `"${ogImage[1]}"` : "missing"}, expected it to start with ${siteOrigin}.`,
    );
  }
  console.log(`[smoke] ${url} OK (200, prerendered HTML, canonical/OG tags)`);
}

async function checkRoute(base, route, siteOrigin) {
  if (route === "/") {
    await checkRouteUrl(`${base}/`, route, siteOrigin);
    return;
  }
  // Both URL forms must serve this route's prerendered page: the
  // directory-index form (route/) and the non-trailing-slash form, which
  // production maps to route/index.html via artifact.toml rewrites and
  // vite preview maps via the prerender-trailing-slash plugin. Without
  // that mapping the non-slash URL falls through to the SPA fallback and
  // serves the homepage with the wrong canonical tag.
  await checkRouteUrl(`${base}${route}/`, route, siteOrigin);
  await checkRouteUrl(`${base}${route}`, route, siteOrigin);
}

async function main() {
  // Build both BASE_PATH variants (same as the seo-prerender workflow).
  // The "/" build runs last so dist/ ends in the production-root state.
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "site-config-"));
  const fixtureFile = path.join(fixtureDir, "site-config.json");
  await writeFile(fixtureFile, JSON.stringify(SITE_CONFIG_FIXTURE));

  for (const basePath of ["/site/", "/"]) {
    console.log(`[smoke] building website with BASE_PATH=${basePath} ...`);
    await run("pnpm", ["run", "build"], {
      BASE_PATH: basePath,
      NODE_ENV: "production",
      PORT: process.env.PORT ?? "5000",
      SITE_CONFIG_FILE: fixtureFile,
    });
  }

  // Load the routes + site origin from the freshly built SSR bundle (same
  // source as the sitemap / verify-seo).
  const serverEntry = path.join(artifactDir, "dist", "server", "entry-server.js");
  const { listRoutes, getBusiness } = await import(serverEntry);
  const { SITE_ORIGIN } = getBusiness();
  const routes = sampleRoutes(listRoutes());
  if (routes.length < 2) {
    throw new Error(`listRoutes() returned too few routes to spot-check (got ${listRoutes().length}).`);
  }

  // Serve the built output and verify representative pages respond.
  const port = await getFreePort();
  console.log(`[smoke] serving built output on port ${port} ...`);
  const server = spawn(
    "pnpm",
    ["exec", "vite", "preview", "--config", "vite.config.ts", "--port", String(port), "--strictPort", "--host", "127.0.0.1"],
    {
      cwd: artifactDir,
      env: { ...process.env, BASE_PATH: "/", NODE_ENV: "production", PORT: String(port) },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );

  let exited = false;
  let exitInfo = null;
  server.on("exit", (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
  });

  try {
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + SERVE_TIMEOUT_MS;
    for (;;) {
      if (exited) {
        throw new Error(
          `Preview server crashed at startup (exit code ${exitInfo?.code}, signal ${exitInfo?.signal}).`,
        );
      }
      if (Date.now() > deadline) {
        throw new Error(`Preview server did not respond within ${SERVE_TIMEOUT_MS}ms.`);
      }
      try {
        await fetch(`${base}/`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    for (const route of routes) {
      await checkRoute(base, route, SITE_ORIGIN);
    }

    // Config-only area: raw prerendered HTML must carry its city-specific
    // head tags, with og:image pointing at the API's server-rendered card
    // (never the generic og-default.png).
    const configRoute = `/service-areas/${CONFIG_ONLY_AREA.slug}`;
    await checkRoute(base, configRoute, SITE_ORIGIN);
    const configHtml = await (await fetch(`${base}${configRoute}/`)).text();
    const expectedCard = `${SITE_ORIGIN}/api/v1/public/og/area/${CONFIG_ONLY_AREA.slug}.png`;
    if (!configHtml.includes(`<meta property="og:image" content="${expectedCard}"`)) {
      throw new Error(`${configRoute}: og:image is not the API share card (expected ${expectedCard}).`);
    }
    if (!configHtml.includes(CONFIG_ONLY_AREA.name)) {
      throw new Error(`${configRoute}: prerendered HTML does not mention "${CONFIG_ONLY_AREA.name}".`);
    }
    console.log(`[smoke] ${configRoute} OK (config-only area prerendered with API share card)`);

    console.log(
      `[smoke] PASSED: website builds for all BASE_PATH variants and serves ${routes.length} spot-checked pages.`,
    );
  } finally {
    if (!exited) server.kill("SIGTERM");
  }
}

main().catch((err) => {
  console.error(`[smoke] FAILED: ${err.message}`);
  process.exit(1);
});
