import { Link, useRoute } from 'wouter';
import { ArrowRight, CheckCircle2, Phone, ShieldAlert } from 'lucide-react';
import NotFound from '@/pages/not-found';
import { Seo, breadcrumbJsonLd, faqJsonLd, serviceJsonLd } from '@/lib/seo';
import { Breadcrumbs, CtaSection, FaqList, PageHero, SectionHeading } from '@/components/page-blocks';
import { useAnalytics } from '@/lib/analytics';
import { useSiteConfig } from '@/lib/site-config';
import { SITE_ORIGIN } from '@/lib/business';
import { SERVICES_BY_SLUG } from '@/content/services';

/**
 * Page-specific 1200x630 share cards for top services (public/og-service-*.png,
 * regenerated via scripts/generate-og-images.mjs). Other services fall back to
 * the site-wide default image in <Seo>.
 */
const SERVICE_OG_IMAGES: Record<string, string> = {
  'roof-repair': '/og-service-roof-repair.png',
  'roof-replacement': '/og-service-roof-replacement.png',
  'storm-damage': '/og-service-storm-damage.png',
};

export default function ServicePage() {
  const [, params] = useRoute('/services/:slug');
  const { business: BUSINESS, areas, servicesBySlug } = useSiteConfig();
  // Config-driven lookup first; static fallback keeps prerendered/legacy pages rendering.
  const service = params?.slug
    ? (servicesBySlug.get(params.slug) ?? SERVICES_BY_SLUG.get(params.slug))
    : undefined;
  const { track } = useAnalytics();

  if (!service) return <NotFound />;

  const path = `/services/${service.slug}`;
  const related = service.relatedSlugs
    .map((slug) => servicesBySlug.get(slug) ?? SERVICES_BY_SLUG.get(slug))
    .filter((s): s is NonNullable<typeof s> => Boolean(s));

  return (
    <div className="flex-1">
      <Seo
        title={service.metaTitle}
        description={service.metaDescription}
        path={path}
        ogImage={SERVICE_OG_IMAGES[service.slug] ? `${SITE_ORIGIN}${SERVICE_OG_IMAGES[service.slug]}` : undefined}
        jsonLd={[
          serviceJsonLd(
            { name: service.name, description: service.metaDescription, path },
            { business: BUSINESS, areaServed: areas.map((a) => `${a.city} ${BUSINESS.state}`) },
          ),
          breadcrumbJsonLd([
            { name: 'Home', path: '/' },
            { name: 'Services', path: '/services' },
            { name: service.name, path },
          ]),
          faqJsonLd(service.faqs),
        ]}
      />

      <div className="container mx-auto px-4 max-w-4xl pt-10">
        <Breadcrumbs items={[{ name: 'Home', href: '/' }, { name: 'Services', href: '/services' }, { name: service.name }]} />
      </div>

      <PageHero eyebrow={service.name} title={service.headline} lede={service.intro}>
        <div className="mt-10 flex flex-col sm:flex-row gap-4">
          <Link
            href="/assessment"
            onClick={() => track('cta_clicked', { label: `service_${service.slug}_assessment` })}
            className="px-7 py-3.5 bg-primary text-primary-foreground font-semibold rounded-xl hover:bg-accent transition-colors flex items-center justify-center gap-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            Start My Roof Assessment <ArrowRight aria-hidden className="w-4 h-4" />
          </Link>
          <a
            href={BUSINESS.phoneHref}
            onClick={() => track('phone_clicked', { label: `service_${service.slug}_phone` })}
            className="px-7 py-3.5 bg-white/5 border border-white/10 text-white font-semibold rounded-xl hover:bg-white/10 transition-colors flex items-center justify-center gap-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <Phone aria-hidden className="w-4 h-4 text-primary" /> {BUSINESS.phone}
          </a>
        </div>
        {service.emergency && (
          <p className="mt-6 inline-flex items-center gap-2 text-sm text-orange-300 bg-orange-400/10 border border-orange-400/20 rounded-full px-4 py-2">
            <ShieldAlert aria-hidden className="w-4 h-4" /> 24/7 emergency response available — call any time.
          </p>
        )}
      </PageHero>

      {service.problems.length > 0 && (
      <section className="py-16 border-t border-white/5">
        <div className="container mx-auto px-4 max-w-4xl">
          <SectionHeading sub="If any of these sound familiar, it's worth a professional look.">Signs you need {service.name.toLowerCase()}</SectionHeading>
          <ul className="grid sm:grid-cols-2 gap-4">
            {service.problems.map((problem) => (
              <li key={problem} className="flex items-start gap-3 p-5 rounded-2xl bg-card/40 border border-card-border">
                <CheckCircle2 aria-hidden className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                <span className="text-foreground/90 leading-relaxed">{problem}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>
      )}

      {service.process.length > 0 && (
      <section className="py-16 border-t border-white/5 bg-card/10">
        <div className="container mx-auto px-4 max-w-4xl">
          <SectionHeading sub="Clear communication at every step — you always know what happens next.">How we work</SectionHeading>
          <ol className="space-y-6">
            {service.process.map((step, i) => (
              <li key={step.title} className="flex gap-5">
                <div aria-hidden className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary font-display font-bold shrink-0">
                  {i + 1}
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-white mb-1">{step.title}</h3>
                  <p className="text-muted-foreground leading-relaxed">{step.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>
      )}

      {service.faqs.length > 0 && (
      <section className="py-16 border-t border-white/5">
        <div className="container mx-auto px-4 max-w-4xl">
          <SectionHeading>Common questions</SectionHeading>
          <FaqList faqs={service.faqs} />
        </div>
      </section>
      )}

      {related.length > 0 && (
      <section className="py-16 border-t border-white/5 bg-card/10">
        <div className="container mx-auto px-4 max-w-4xl">
          <SectionHeading>Related services</SectionHeading>
          <div className="grid sm:grid-cols-2 gap-4">
            {related.map((rel) => (
              <Link
                key={rel.slug}
                href={`/services/${rel.slug}`}
                className="group p-6 rounded-2xl bg-card/40 border border-card-border hover:border-primary/40 transition-colors focus-visible:outline-2 focus-visible:outline-primary"
              >
                <div className="flex items-center gap-3 mb-2">
                  <rel.icon aria-hidden className="w-5 h-5 text-primary" />
                  <span className="font-semibold text-white group-hover:text-primary transition-colors">{rel.name}</span>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">{rel.teaser}</p>
              </Link>
            ))}
          </div>
        </div>
      </section>
      )}

      <CtaSection trackLabel={`service_${service.slug}`} />
    </div>
  );
}

export function ServicesIndexPage() {
  const { track } = useAnalytics();
  const { services: SERVICES } = useSiteConfig();
  return (
    <div className="flex-1">
      <Seo
        title="Roofing & Restoration Services"
        description="Every roofing and water restoration service Painless Roofing offers in Canton, GA and North Georgia — repair, replacement, metal, storm damage, insurance help, and 24/7 emergency response."
        path="/services"
        jsonLd={breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'Services', path: '/services' },
        ])}
      />
      <div className="container mx-auto px-4 max-w-6xl pt-10">
        <Breadcrumbs items={[{ name: 'Home', href: '/' }, { name: 'Services' }]} />
      </div>
      <PageHero
        eyebrow="Services"
        title="Everything above your walls, and the water that gets past them."
        lede="From a single missing shingle to a full storm restoration with insurance in the middle — one family-owned team, one standard of work."
      />
      <section className="pb-20">
        <div className="container mx-auto px-4 max-w-6xl">
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {SERVICES.map((service) => (
              <Link
                key={service.slug}
                href={`/services/${service.slug}`}
                onClick={() => track('cta_clicked', { label: `services_index_${service.slug}` })}
                className="group flex flex-col p-7 rounded-3xl bg-card/40 border border-card-border hover:border-primary/40 hover:bg-card/70 transition-colors focus-visible:outline-2 focus-visible:outline-primary"
              >
                <service.icon aria-hidden className="w-8 h-8 text-primary mb-5" />
                <h2 className="text-xl font-display font-semibold text-white mb-2 group-hover:text-primary transition-colors">{service.name}</h2>
                <p className="text-muted-foreground text-sm leading-relaxed flex-1">{service.teaser}</p>
                <span className="mt-5 inline-flex items-center gap-1.5 text-primary text-sm font-medium">
                  Learn more <ArrowRight aria-hidden className="w-4 h-4 group-hover:translate-x-1 transition-transform motion-reduce:transition-none" />
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>
      <CtaSection trackLabel="services_index" />
    </div>
  );
}
