# Painless Roofing Website — Client Template

A fully server-side rendered, SEO-optimised marketing website for a roofing / restoration business. Includes a storm-check tool, per-city service area pages, an AI concierge widget, homeowner portal access, and structured data for Google.

---

## Rebranding for a new client

**Everything client-specific lives in one file. Edit it first.**

| File | What to change |
|---|---|
| `artifacts/website/src/lib/client.config.ts` | Business name, phone, address, hours, Facebook URL, Google review link, tagline, production domain (`SITE_ORIGIN`) |

After editing that file:

1. **Logo** — replace `artifacts/website/public/logo.png` (OG image, ~800×400) and `public/favicon.svg` (browser tab icon) with the new client's assets.
2. **Page title & meta** — update the `<title>` and `<meta name="description">` in `artifacts/website/index.html`. The SSR prerender will fill in most OG tags automatically from `client.config.ts`, but the base HTML fallbacks need updating too.
3. **Service areas** — update `artifacts/website/src/content/areas.ts` with the new client's service cities, descriptions, and coordinates.
4. **Primary color** — update `--color-primary` in `artifacts/website/src/index.css` (search for `hsl(` and the `198` value) to the new client's brand color.
5. **Fonts** — `index.html` uses Google Fonts `Inter`. Swap in a different font family if the client requires it.

---

## Local development

### Prerequisites
- Node 22+
- pnpm 9+

### Setup

```bash
# Install dependencies
pnpm install

# Start the dev server (SSR + HMR)
pnpm --filter @workspace/website run dev
```

The site will be available at `http://localhost:5174` (or the port printed by Vite).

---

## Building & prerendering

```bash
# Full production build (SSR bundle + static prerender)
pnpm --filter @workspace/website run build
```

This produces `artifacts/website/dist/` with:
- `client/` — browser JS/CSS bundle
- `server/` — SSR entry
- `static/` — prerendered HTML for each route (for CDN/static hosting)

---

## Deploying

**Static hosting (Netlify, Vercel, Cloudflare Pages, etc.)**

Upload the contents of `dist/static/`. Add a catch-all rewrite rule pointing `/* → /index.html` for client-side routing to work on non-prerendered routes.

**Node server (Replit, Railway, Render, etc.)**

Run the SSR server:
```bash
node artifacts/website/dist/server/entry-server.js
```

Set `PORT` in your environment; the server will listen there.

---

## Architecture

```
artifacts/
  website/
    src/
      lib/
        client.config.ts  ← rebrand here
        business.ts       (re-exports from client.config for compatibility)
      content/
        areas.ts          service area cities
      pages/              route components (SSR + client)
      components/         shared UI
    public/               static assets (logo, favicon)
    index.html            base HTML (update title + meta tags)
  api-server/             Node.js API (contact form, concierge, storm check)
lib/
  api-zod/                Shared API schema
  api-client-react/       React Query hooks
```
