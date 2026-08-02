import { Link, useRoute } from 'wouter';
import { ArrowRight, MapPin } from 'lucide-react';
import NotFound from '@/pages/not-found';
import { AREAS, AREAS_BY_SLUG } from '@/content/areas';
import { SERVICES_BY_SLUG } from '@/content/services';
import { Seo, breadcrumbJsonLd, localBusinessJsonLd } from '@/lib/seo';
import { Breadcrumbs, CtaSection, PageHero, SectionHeading } from '@/components/page-blocks';
import { useAnalytics } from '@/lib/analytics';
import { useSiteConfig } from '@/lib/site-config';
import { SITE_ORIGIN } from '@/lib/business';

// Share cards follow a naming convention derived from the areas content, so a
// newly added area in src/content/areas.ts automatically points at its card.
// scripts/generate-og-images.mjs produces public/og-area-<slug>.png for every
// area, and scripts/verify-seo.mjs fails the build if a prerendered area page
// references a card that doesn't exist (or falls back to og-default.png).
// Areas that only exist in org site config (not prerendered) get a
// server-rendered card from the API instead (GET /api/v1/public/og/area/:slug),
// so they no longer fall back to the generic og-default.png.
const AREA_OG_IMAGES: Map<string, string> = new Map(
  AREAS.map((a) => [a.slug, `/og-area-${a.slug}.png`]),
);

function areaOgImage(slug: string): string {
  const staticCard = AREA_OG_IMAGES.get(slug);
  return staticCard
    ? `${SITE_ORIGIN}${staticCard}`
    : `${SITE_ORIGIN}/api/v1/public/og/area/${slug}.png`;
}

export default function AreaPage() {
  const [, params] = useRoute('/service-areas/:slug');
  const { business, areasBySlug, servicesBySlug } = useSiteConfig();
  // Config-driven lookup first; static fallback keeps prerendered/legacy pages rendering.
  const area = params?.slug
    ? (areasBySlug.get(params.slug) ?? AREAS_BY_SLUG.get(params.slug))
    : undefined;

  if (!area) return <NotFound />;

  const path = `/service-areas/${area.slug}`;
  const featured = area.featuredServiceSlugs
    .map((slug) => servicesBySlug.get(slug) ?? SERVICES_BY_SLUG.get(slug))
    .filter((s): s is NonNullable<typeof s> => Boolean(s));

  return (
    <div className="flex-1">
      <Seo
        title={area.metaTitle}
        description={area.metaDescription}
        path={path}
        ogImage={areaOgImage(area.slug)}
        jsonLd={[
          localBusinessJsonLd(business),
          breadcrumbJsonLd([
            { name: 'Home', path: '/' },
            { name: 'Service Areas', path: '/service-areas' },
            { name: area.city, path },
          ]),
        ]}
      />
      <div className="container mx-auto px-4 max-w-4xl pt-10">
        <Breadcrumbs items={[{ name: 'Home', href: '/' }, { name: 'Service Areas', href: '/service-areas' }, { name: area.city }]} />
      </div>
      <PageHero eyebrow={`Roofing in ${area.city}, GA`} title={area.headline} lede={area.localContext} />

      {area.commonNeeds.length > 0 && (
      <section className="py-16 border-t border-white/5">
        <div className="container mx-auto px-4 max-w-4xl">
          <SectionHeading>What {area.city} homes ask us for most</SectionHeading>
          <ul className="space-y-4">
            {area.commonNeeds.map((need) => (
              <li key={need} className="flex items-start gap-3 p-5 rounded-2xl bg-card/40 border border-card-border">
                <MapPin aria-hidden className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                <span className="text-foreground/90 leading-relaxed">{need}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>
      )}

      {featured.length > 0 && (
      <section className="py-16 border-t border-white/5 bg-card/10">
        <div className="container mx-auto px-4 max-w-4xl">
          <SectionHeading sub={`The services ${area.city} homeowners reach for first.`}>Popular services in {area.city}</SectionHeading>
          <div className="grid sm:grid-cols-2 gap-4">
            {featured.map((service) => (
              <Link
                key={service.slug}
                href={`/services/${service.slug}`}
                className="group p-6 rounded-2xl bg-card/40 border border-card-border hover:border-primary/40 transition-colors focus-visible:outline-2 focus-visible:outline-primary"
              >
                <div className="flex items-center gap-3 mb-2">
                  <service.icon aria-hidden className="w-5 h-5 text-primary" />
                  <span className="font-semibold text-white group-hover:text-primary transition-colors">{service.name}</span>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">{service.teaser}</p>
              </Link>
            ))}
          </div>
        </div>
      </section>
      )}

      <CtaSection
        heading={`Need a roofer in ${area.city}?`}
        trackLabel={`area_${area.slug}`}
      />
    </div>
  );
}

export function AreasIndexPage() {
  const { track } = useAnalytics();
  const { areas: AREAS } = useSiteConfig();
  return (
    <div className="flex-1">
      <Seo
        title="Service Areas — North Georgia Roofing"
        description="Painless Roofing & Water Restoration serves Canton, Atlanta, Dawsonville, Cumming, Alpharetta, and Gainesville, Georgia — based in Canton, open 24 hours."
        path="/service-areas"
        jsonLd={breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'Service Areas', path: '/service-areas' },
        ])}
      />
      <div className="container mx-auto px-4 max-w-5xl pt-10">
        <Breadcrumbs items={[{ name: 'Home', href: '/' }, { name: 'Service Areas' }]} />
      </div>
      <PageHero
        eyebrow="Service Areas"
        title="Based in Canton. At home across North Georgia."
        lede="We serve the communities we live around — close enough to show up fast when a storm hits, familiar enough to know what local roofs go through."
      />
      <section className="pb-20">
        <div className="container mx-auto px-4 max-w-5xl">
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {AREAS.map((area) => (
              <Link
                key={area.slug}
                href={`/service-areas/${area.slug}`}
                onClick={() => track('cta_clicked', { label: `areas_index_${area.slug}` })}
                className="group p-7 rounded-3xl bg-card/40 border border-card-border hover:border-primary/40 hover:bg-card/70 transition-colors focus-visible:outline-2 focus-visible:outline-primary"
              >
                <MapPin aria-hidden className="w-7 h-7 text-primary mb-4" />
                <h2 className="text-xl font-display font-semibold text-white mb-2 group-hover:text-primary transition-colors">{area.city}, GA</h2>
                <p className="text-sm text-muted-foreground leading-relaxed line-clamp-3">{area.metaDescription.split('.')[0]}.</p>
                <span className="mt-4 inline-flex items-center gap-1.5 text-primary text-sm font-medium">
                  View {area.city} <ArrowRight aria-hidden className="w-4 h-4 group-hover:translate-x-1 transition-transform motion-reduce:transition-none" />
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>
      <CtaSection trackLabel="areas_index" />
    </div>
  );
}
