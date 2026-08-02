import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { Hammer } from 'lucide-react';
import { useGetPublicSiteConfig, type PublicSiteConfig } from '@workspace/api-client-react';
import { BUSINESS } from '@/lib/business';
import { SERVICES, SERVICES_BY_SLUG, type ServiceContent } from '@/content/services';
import { AREAS, AREAS_BY_SLUG, type AreaContent } from '@/content/areas';

/**
 * Runtime site configuration: admin-managed business profile, services,
 * and service areas fetched from the public API and merged over the
 * hand-authored static defaults. Static content stays the source of the
 * rich page copy; the config decides *which* services/areas are listed
 * and the NAP facts (name, phone, hours).
 */

export type BusinessInfo = { [K in keyof typeof BUSINESS]: string };

export interface SiteConfig {
  business: BusinessInfo;
  /** Active services, config order; static copy merged in when available. */
  services: ServiceContent[];
  /** Active areas, config order; static copy merged in when available. */
  areas: AreaContent[];
  servicesBySlug: Map<string, ServiceContent>;
  areasBySlug: Map<string, AreaContent>;
}

const STATIC_CONFIG: SiteConfig = {
  business: BUSINESS,
  services: SERVICES,
  areas: AREAS,
  servicesBySlug: SERVICES_BY_SLUG,
  areasBySlug: AREAS_BY_SLUG,
};

const SiteConfigContext = createContext<SiteConfig>(STATIC_CONFIG);

/** "(404) 444-4476" -> { href: "tel:+14044444476", e164: "+14044444476" } */
function phoneVariants(phone: string): { href: string; e164: string } {
  const digits = phone.replace(/\D/g, '');
  const e164 = digits.length === 10 ? `+1${digits}` : digits.startsWith('+') ? digits : `+${digits}`;
  return { href: `tel:${e164}`, e164 };
}

function fallbackService(entry: { slug: string; name: string; description?: string }): ServiceContent {
  const teaser = entry.description?.trim() || `${entry.name} handled by our licensed, family-owned team.`;
  return {
    slug: entry.slug,
    name: entry.name,
    shortName: entry.name,
    icon: Hammer,
    teaser,
    metaTitle: `${entry.name} in ${BUSINESS.city} & Metro Atlanta, ${BUSINESS.state}`,
    metaDescription: `${entry.name} from ${BUSINESS.name}. ${teaser} Call ${BUSINESS.phone}.`,
    headline: entry.name,
    intro: teaser,
    problems: [],
    process: [],
    faqs: [],
    relatedSlugs: [],
  };
}

function fallbackArea(entry: { slug: string; name: string; state?: string }): AreaContent {
  return {
    slug: entry.slug,
    city: entry.name,
    metaTitle: `Roofing Contractor in ${entry.name}, ${entry.state ?? 'GA'}`,
    metaDescription: `Roof repair, replacement, and storm restoration for ${entry.name}, ${entry.state ?? 'GA'} homes from ${BUSINESS.name}. Call ${BUSINESS.phone}.`,
    headline: `Roofing in ${entry.name}, done painlessly.`,
    localContext: `We serve ${entry.name} with the same crew and standards we bring everywhere in North Georgia — clear communication, quality materials, honest assessments.`,
    commonNeeds: [],
    featuredServiceSlugs: [],
  };
}

export function SiteConfigProvider({
  children,
  ssrData,
}: {
  children: ReactNode;
  /**
   * Build-time site config payload used when no client fetch has resolved —
   * lets the prerenderer render config-only area pages with real head tags.
   */
  ssrData?: PublicSiteConfig;
}) {
  const { data: fetched } = useGetPublicSiteConfig({
    query: {
      queryKey: ['public-site-config'],
      staleTime: 5 * 60 * 1000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  });

  const data = fetched ?? ssrData;
  const value = useMemo<SiteConfig>(() => {
    if (!data) return STATIC_CONFIG;

    const profile = data.businessProfile ?? {};
    const phone = profile.phone?.trim() || BUSINESS.phone;
    const { href, e164 } = phoneVariants(phone);
    const business: BusinessInfo = {
      ...BUSINESS,
      name: profile.businessName?.trim() || BUSINESS.name,
      legalName: profile.businessName?.trim() || BUSINESS.legalName,
      phone,
      phoneHref: href,
      phoneE164: e164,
      city: profile.city?.trim() || BUSINESS.city,
      state: profile.state?.trim() || BUSINESS.state,
      postalCode: profile.postalCode?.trim() || BUSINESS.postalCode,
      hours: profile.hours?.trim() || BUSINESS.hours,
      facebook: profile.facebookUrl?.trim() || BUSINESS.facebook,
    };

    const services = (data.services ?? []).map((entry) => {
      const staticContent = SERVICES_BY_SLUG.get(entry.slug);
      return staticContent ? { ...staticContent, name: entry.name || staticContent.name } : fallbackService(entry);
    });
    const areas = (data.serviceAreas ?? []).map((entry) => {
      const staticContent = AREAS_BY_SLUG.get(entry.slug);
      return staticContent ? { ...staticContent, city: entry.name || staticContent.city } : fallbackArea(entry);
    });

    return {
      business,
      services,
      areas,
      servicesBySlug: new Map(services.map((s) => [s.slug, s])),
      areasBySlug: new Map(areas.map((a) => [a.slug, a])),
    };
  }, [data]);

  return <SiteConfigContext.Provider value={value}>{children}</SiteConfigContext.Provider>;
}

/** Admin-configured site data, falling back to the static defaults. */
export function useSiteConfig(): SiteConfig {
  return useContext(SiteConfigContext);
}

export function useBusiness(): BusinessInfo {
  return useContext(SiteConfigContext).business;
}
