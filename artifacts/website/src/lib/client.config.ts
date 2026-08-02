/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║                CLIENT CONFIGURATION — REBRAND HERE           ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * This is the single file to edit when deploying this website for a
 * new client. After updating these values:
 *   1. Replace public/logo.png and public/favicon.svg with the new
 *      client's logo (PNG for OG tags, SVG for browser tab).
 *   2. Update index.html <title>, <meta description>, and OG/Twitter
 *      tags to match the new client (or let the SSR prerender handle
 *      it automatically from BUSINESS below).
 *   3. Update src/content/areas.ts with the new client's service area
 *      cities and descriptions.
 *   4. Update SITE_ORIGIN to the new client's production domain.
 */

/** Central business facts — single source of truth for NAP, links, hours. */
export const BUSINESS = {
  name: 'Painless Roofing & Water Restoration',
  legalName: 'Painless Roofing & Water Restoration',
  phone: '(404) 444-4476',
  phoneHref: 'tel:+14044444476',
  phoneE164: '+14044444476',
  city: 'Canton',
  state: 'GA',
  postalCode: '30115',
  hours: 'Open 24 Hours, Mon–Sun',
  facebook: 'https://www.facebook.com/profile.php?id=100091288854561',
  /**
   * Direct "write a review" link — replace with your Google Business Profile
   * short link, e.g. https://g.page/r/YOUR_PLACE_ID/review
   * Get it from: Google Business Profile → Get more reviews → Share review form
   */
  googleReviewUrl:
    'https://www.google.com/search?q=Painless+Roofing+%26+Water+Restoration+Canton+GA#lrd=,3',
  tagline:
    'Family-owned roof repair and restoration built on clear communication and quality materials.',
} as const;

/** Canonical production origin for SEO tags. */
export const SITE_ORIGIN = 'https://painlessroofingandwaterrestoration.com';

/**
 * Brand primary color (HSL, for Tailwind CSS compatibility).
 * Keep in sync with --color-primary in src/index.css.
 * Current: International Klein Blue (#0033A0).
 */
export const PRIMARY_COLOR_HSL = '218 100% 31%';
