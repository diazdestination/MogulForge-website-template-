import { createContext, useContext, useEffect } from 'react';
import { BUSINESS, SITE_ORIGIN } from '@/lib/business';
import { useBusiness, type BusinessInfo } from '@/lib/site-config';

type JsonLd = Record<string, unknown>;

/** Collected head data for a route, used by the build-time prerenderer. */
export interface CollectedHead {
  title: string;
  description: string;
  canonical: string;
  ogImage: string;
  jsonLd: JsonLd[];
}

/** During prerendering, Seo writes into this collector instead of the DOM. */
export const HeadCollectorContext = createContext<{ head: CollectedHead | null } | null>(null);

interface SeoProps {
  title: string;
  description: string;
  /** Site-relative path used for the canonical + og:url, e.g. "/services/roof-repair" */
  path: string;
  jsonLd?: JsonLd | JsonLd[];
  ogImage?: string;
}

function setMeta(attr: 'name' | 'property', key: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

const JSONLD_ATTR = 'data-seo-jsonld';

/**
 * Client-side SEO manager for this SPA: document title, description,
 * canonical, Open Graph, and JSON-LD structured data per route.
 */
export function Seo({ title, description, path, jsonLd, ogImage }: SeoProps) {
  const collector = useContext(HeadCollectorContext);
  const business = useBusiness();

  // Server/prerender path: record head data synchronously during render.
  if (collector) {
    const fullTitle = title.includes(business.name) ? title : `${title} | ${business.name}`;
    collector.head = {
      title: fullTitle,
      description,
      canonical: `${SITE_ORIGIN}${path === '/' ? '/' : path.replace(/\/$/, '')}`,
      ogImage: ogImage ?? `${SITE_ORIGIN}/og-default.png`,
      jsonLd: jsonLd ? (Array.isArray(jsonLd) ? jsonLd : [jsonLd]) : [],
    };
  }

  useEffect(() => {
    const fullTitle = title.includes(business.name) ? title : `${title} | ${business.name}`;
    document.title = fullTitle;
    const canonical = `${SITE_ORIGIN}${path === '/' ? '/' : path.replace(/\/$/, '')}`;
    const image = ogImage ?? `${SITE_ORIGIN}/og-default.png`;

    setMeta('name', 'description', description);
    setMeta('property', 'og:title', fullTitle);
    setMeta('property', 'og:description', description);
    setMeta('property', 'og:type', 'website');
    setMeta('property', 'og:url', canonical);
    setMeta('property', 'og:image', image);
    setMeta('property', 'og:site_name', business.name);
    setMeta('name', 'twitter:card', 'summary_large_image');
    setMeta('name', 'twitter:title', fullTitle);
    setMeta('name', 'twitter:description', description);
    setMeta('name', 'twitter:image', image);

    let link = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'canonical';
      document.head.appendChild(link);
    }
    link.href = canonical;

    // Replace route-scoped JSON-LD blocks.
    document.head.querySelectorAll(`script[${JSONLD_ATTR}]`).forEach((n) => n.remove());
    const blocks = jsonLd ? (Array.isArray(jsonLd) ? jsonLd : [jsonLd]) : [];
    for (const block of blocks) {
      const script = document.createElement('script');
      script.type = 'application/ld+json';
      script.setAttribute(JSONLD_ATTR, 'true');
      script.textContent = JSON.stringify(block);
      document.head.appendChild(script);
    }
  }, [title, description, path, ogImage, business.name, JSON.stringify(jsonLd)]);

  return null;
}

export function localBusinessJsonLd(business: BusinessInfo = BUSINESS): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'RoofingContractor',
    name: business.name,
    telephone: business.phoneE164,
    url: SITE_ORIGIN,
    logo: `${SITE_ORIGIN}/logo.png`,
    image: `${SITE_ORIGIN}/logo.png`,
    address: {
      '@type': 'PostalAddress',
      addressLocality: business.city,
      addressRegion: business.state,
      postalCode: business.postalCode,
      addressCountry: 'US',
    },
    openingHoursSpecification: {
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
      opens: '00:00',
      closes: '23:59',
    },
    sameAs: [business.facebook],
  };
}

export function serviceJsonLd(
  input: { name: string; description: string; path: string },
  options?: { business?: BusinessInfo; areaServed?: string[] },
): JsonLd {
  const business = options?.business ?? BUSINESS;
  return {
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: input.name,
    description: input.description,
    url: `${SITE_ORIGIN}${input.path}`,
    provider: { '@type': 'RoofingContractor', name: business.name, telephone: business.phoneE164 },
    areaServed: options?.areaServed ?? ['Canton GA', 'Atlanta GA', 'Dawsonville GA', 'Cumming GA', 'Alpharetta GA', 'Gainesville GA'],
  };
}

export function breadcrumbJsonLd(items: Array<{ name: string; path: string }>): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: `${SITE_ORIGIN}${item.path}`,
    })),
  };
}

export function faqJsonLd(faqs: Array<{ question: string; answer: string }>): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((f) => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: { '@type': 'Answer', text: f.answer },
    })),
  };
}
