import { renderToString } from 'react-dom/server';

import App, { LEGACY_REDIRECTS } from './App';

export { LEGACY_REDIRECTS };
import { HeadCollectorContext, type CollectedHead } from '@/lib/seo';
import { SERVICES } from '@/content/services';
import { AREAS } from '@/content/areas';
import { BUSINESS, SITE_ORIGIN } from '@/lib/business';
import type { PublicSiteConfig } from '@workspace/api-client-react';

/** All prerenderable public routes (relative to the site base). */
export function listRoutes(): string[] {
  return [
    '/',
    '/storm-check',
    '/assessment',
    '/services',
    '/service-areas',
    '/about',
    '/gallery',
    '/reviews',
    '/financing',
    '/resources',
    '/contact',
    '/nationwide',
    '/privacy',
    '/terms',
    '/sms-consent',
    '/accessibility',
    ...SERVICES.map((s) => `/services/${s.slug}`),
    ...AREAS.map((a) => `/service-areas/${a.slug}`),
  ];
}

export function getBusiness() {
  return { BUSINESS, SITE_ORIGIN };
}

export function getContent() {
  return { SERVICES, AREAS };
}

/**
 * Routes for service areas that exist only in the org site config payload
 * (added via CRM site settings, no static content). Prerendering these too
 * gives crawlers real per-city head tags instead of the homepage shell.
 */
export function listConfigOnlyAreaRoutes(siteConfig: PublicSiteConfig | null | undefined): string[] {
  if (!siteConfig?.serviceAreas) return [];
  const staticSlugs = new Set(AREAS.map((a) => a.slug));
  return siteConfig.serviceAreas
    .filter((a) => a.isActive && !staticSlugs.has(a.slug))
    .map((a) => `/service-areas/${a.slug}`);
}

/** Render a route to HTML plus its collected head tags. */
export function render(
  path: string,
  options?: { siteConfig?: PublicSiteConfig },
): { html: string; head: CollectedHead | null } {
  const collector: { head: CollectedHead | null } = { head: null };
  // The router mounts with a base; ssrPath must be the full path including it.
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  const ssrPath = `${base}${path}` || '/';
  const html = renderToString(
    <HeadCollectorContext.Provider value={collector}>
      <App ssrPath={ssrPath} ssrSiteConfig={options?.siteConfig} />
    </HeadCollectorContext.Provider>,
  );
  return { html, head: collector.head };
}
