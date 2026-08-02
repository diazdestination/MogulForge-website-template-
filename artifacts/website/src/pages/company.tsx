import { Link } from 'wouter';
import { ArrowRight, HeartHandshake, MessageSquareQuote, ShieldCheck, Star, Wrench } from 'lucide-react';
import { GoogleReviewCta } from '@/components/google-review-cta';
import { Seo, breadcrumbJsonLd, localBusinessJsonLd } from '@/lib/seo';
import { Breadcrumbs, CtaSection, PageHero, SectionHeading } from '@/components/page-blocks';
import { useBusiness } from '@/lib/site-config';
import { useReviews } from '@/lib/use-reviews';

export function AboutPage() {
  const BUSINESS = useBusiness();
  return (
    <div className="flex-1">
      <Seo
        title="About Us — Family-Owned Roofing in Canton, GA"
        description="Painless Roofing & Water Restoration is a family-owned Canton, GA company built on clear communication, quality materials, and honest assessments. Open 24 hours."
        path="/about"
        jsonLd={[localBusinessJsonLd(BUSINESS), breadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: 'About', path: '/about' }])]}
      />
      <div className="container mx-auto px-4 max-w-4xl pt-10">
        <Breadcrumbs items={[{ name: 'Home', href: '/' }, { name: 'About' }]} />
      </div>
      <PageHero
        eyebrow="About Us"
        title="Protect your home with expert care."
        lede={BUSINESS.tagline + ' We started this company because storm recovery in Georgia had become anything but painless — and homeowners deserved better.'}
      />
      <section className="py-16 border-t border-white/5">
        <div className="container mx-auto px-4 max-w-4xl space-y-6 text-lg text-muted-foreground leading-relaxed">
          <p>
            Painless Roofing & Water Restoration is family-owned and based in Canton, Georgia. We work on the roofs of our
            neighbors — which changes how you do business. There's no disappearing after the check clears when you shop at
            the same grocery store as your customers.
          </p>
          <p>
            Georgia is hard on roofs. Summer heat cooks shingles from above while poor attic ventilation cooks them from
            below. Spring storm cells drop hail with no warning, and weeks of rain find every weakness the heat created.
            We built our services around that reality: honest inspections, repairs that fix causes instead of symptoms, and
            water restoration in-house because the leak is only half the problem.
          </p>
          <p>
            We're licensed and insured, open 24 hours because storms don't keep business hours, and we'll tell you when
            your roof is fine — because an assessment that always finds a problem isn't an assessment.
          </p>
        </div>
      </section>
      <section className="py-16 border-t border-white/5 bg-card/10">
        <div className="container mx-auto px-4 max-w-4xl">
          <SectionHeading>What we hold ourselves to</SectionHeading>
          <div className="grid sm:grid-cols-3 gap-5">
            {[
              { icon: MessageSquareQuote, title: 'Clear communication', body: 'You always know what we found, what it costs, and what happens next — in plain language.' },
              { icon: Wrench, title: 'Quality materials', body: 'We install systems we would put on our own homes, from underlayment to ridge cap.' },
              { icon: HeartHandshake, title: 'Honest assessments', body: 'Repair when repair is right. "Your roof is fine" when it is. No invented damage, ever.' },
            ].map((v) => (
              <div key={v.title} className="p-7 rounded-3xl bg-card/40 border border-card-border">
                <v.icon aria-hidden className="w-7 h-7 text-primary mb-4" />
                <h3 className="font-display font-semibold text-white text-lg mb-2">{v.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{v.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
      <CtaSection trackLabel="about" />
    </div>
  );
}

export function ReviewsPage() {
  const BUSINESS = useBusiness();
  const { reviews } = useReviews();
  return (
    <div className="flex-1">
      <Seo
        title="Reviews — What Homeowners Say"
        description="Read what Canton and North Georgia homeowners say about working with Painless Roofing & Water Restoration."
        path="/reviews"
        jsonLd={breadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: 'Reviews', path: '/reviews' }])}
      />
      <div className="container mx-auto px-4 max-w-4xl pt-10">
        <Breadcrumbs items={[{ name: 'Home', href: '/' }, { name: 'Reviews' }]} />
      </div>
      <PageHero
        eyebrow="Reviews"
        title="The work speaks. So do the homeowners."
        lede="We earn our reputation one roof at a time. Here's what that looks like from the homeowner's side."
      />
      <section className="pb-16">
        <div className="container mx-auto px-4 max-w-4xl">
          <div className="grid sm:grid-cols-2 gap-5">
            {reviews.map((r) => (
              <figure key={r.who + r.quote.slice(0, 12)} className="p-7 rounded-3xl bg-card/40 border border-card-border flex flex-col">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex gap-1" aria-label={`${r.rating} out of 5 stars`}>
                    {Array.from({ length: 5 }).map((_, i) => (
                      <Star key={i} aria-hidden className={`w-4 h-4 ${i < r.rating ? 'text-yellow-400 fill-yellow-400' : 'text-muted-foreground/30'}`} />
                    ))}
                  </div>
                  <svg aria-label="Google review" viewBox="0 0 24 24" className="w-4 h-4 opacity-60 shrink-0" fill="none">
                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                  </svg>
                </div>
                <blockquote className="text-foreground/90 leading-relaxed flex-1">"{r.quote}"</blockquote>
                <figcaption className="mt-5 text-sm text-muted-foreground">
                  {r.who}{r.relativeDate ? <span className="ml-2 opacity-60">· {r.relativeDate}</span> : null}
                </figcaption>
              </figure>
            ))}
            <GoogleReviewCta />
          </div>
          <div className="mt-10 p-6 rounded-2xl bg-primary/5 border border-primary/15 text-center">
            <p className="text-muted-foreground">
              Find more reviews on our{' '}
              <a href={BUSINESS.facebook} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary rounded">
                Facebook page
              </a>{' '}
              and Google Business Profile.
            </p>
          </div>
        </div>
      </section>
      <CtaSection trackLabel="reviews" />
    </div>
  );
}

export function GalleryPage() {
  const projects = [
    { title: 'Full architectural shingle replacement', where: 'Canton, GA', detail: 'Hail claim — complete tear-off, deck repairs on two slopes, ridge ventilation added.' },
    { title: 'Standing-seam metal installation', where: 'Dawsonville, GA', detail: 'Exposed ridgeline lot; wind-rated standing-seam system replacing 18-year-old asphalt.' },
    { title: 'Emergency tarp to full restoration', where: 'Gainesville, GA', detail: 'Tree strike through the deck — tarped overnight, rebuilt and reshingled the same week.' },
    { title: 'Water damage recovery', where: 'Atlanta, GA', detail: 'Attic leak into two finished rooms — dried, treated, and restored with the roof repair.' },
    { title: 'Seamless gutter system with guards', where: 'Cumming, GA', detail: 'Oversized downspouts and guards under heavy hardwood canopy near the lake.' },
    { title: 'Designer shingle upgrade', where: 'Alpharetta, GA', detail: 'HOA-approved designer profile with full flashing replacement and cleanup.' },
  ];
  return (
    <div className="flex-1">
      <Seo
        title="Project Gallery — Recent Roofing Work"
        description="Recent roofing and restoration projects by Painless Roofing & Water Restoration across Canton, Atlanta, and North Georgia."
        path="/gallery"
        jsonLd={breadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: 'Project Gallery', path: '/gallery' }])}
      />
      <div className="container mx-auto px-4 max-w-5xl pt-10">
        <Breadcrumbs items={[{ name: 'Home', href: '/' }, { name: 'Project Gallery' }]} />
      </div>
      <PageHero
        eyebrow="Project Gallery"
        title="Recent work, real addresses, no stock photos."
        lede="A sample of recent projects across our service area. Project photography is being added as jobs complete — ask us for photos from work near you."
      />
      <section className="pb-16">
        <div className="container mx-auto px-4 max-w-5xl">
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {projects.map((p) => (
              <div key={p.title} className="p-7 rounded-3xl bg-card/40 border border-card-border flex flex-col">
                <ShieldCheck aria-hidden className="w-6 h-6 text-primary mb-4" />
                <h2 className="font-display font-semibold text-white text-lg mb-1">{p.title}</h2>
                <p className="text-xs uppercase tracking-wider text-primary/80 mb-3">{p.where}</p>
                <p className="text-sm text-muted-foreground leading-relaxed">{p.detail}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
      <CtaSection trackLabel="gallery" />
    </div>
  );
}

export function FinancingPage() {
  return (
    <div className="flex-1">
      <Seo
        title="Roof Financing Options"
        description="Financing options for roof replacement and major repairs with Painless Roofing & Water Restoration — flexible ways to fund the work your home needs."
        path="/financing"
        jsonLd={breadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: 'Financing', path: '/financing' }])}
      />
      <div className="container mx-auto px-4 max-w-4xl pt-10">
        <Breadcrumbs items={[{ name: 'Home', href: '/' }, { name: 'Financing' }]} />
      </div>
      <PageHero
        eyebrow="Financing"
        title="A storm doesn't wait for your budget to be ready."
        lede="We're finalizing financing partnerships so major roof work can be paid over time. In the meantime, we're glad to talk through options on any estimate."
      />
      <section className="pb-16">
        <div className="container mx-auto px-4 max-w-4xl">
          <div className="p-8 rounded-3xl bg-card/40 border border-card-border space-y-4 text-muted-foreground leading-relaxed">
            <p>
              <strong className="text-white">Financing options are coming soon.</strong> We're working with lending
              partners to offer payment plans for roof replacements and major repairs.
            </p>
            <p>
              If storm damage is involved, remember that an approved insurance claim often covers most of the cost minus
              your deductible — start with an <Link href="/services/insurance-claims" className="text-primary hover:underline">honest damage inspection</Link> before assuming
              you need to fund the whole project.
            </p>
            <p>
              Have a project that can't wait? <Link href="/contact" className="text-primary hover:underline">Contact us</Link> and
              we'll walk through what's possible today.
            </p>
          </div>
        </div>
      </section>
      <CtaSection trackLabel="financing" />
    </div>
  );
}

export function ResourcesPage() {
  const resources = [
    { title: 'How to tell hail damage from normal wear', body: 'Hail leaves round bruises with soft, crushed granules underneath — wear shows as even granule loss and exposed mat along edges and high-traffic water paths. Dented gutters and window screens are your best ground-level clue that a closer look is worth it.', href: '/services/storm-damage' },
    { title: 'What to do in the first hour of an active leak', body: 'Move belongings, catch water, and poke a small drain hole in a bulging ceiling to prevent a sudden collapse — then stay off the roof. Tarping wet shingles is how homeowners get hurt.', href: '/services/emergency-roofing' },
    { title: 'Why attic ventilation decides how long your shingles last', body: 'A poorly vented attic in a Georgia summer can run 140°F+, cooking shingles from below and voiding some warranties. Balanced intake and exhaust ventilation is the cheapest life-extension a roof can get.', href: '/services/roof-repair' },
    { title: 'The insurance claim timeline, honestly explained', body: 'Inspection first, then the claim, then the adjuster meeting, then scope reconciliation. Knowing the order — and that nobody can guarantee an approval — keeps you in control of the process.', href: '/services/insurance-claims' },
    { title: 'Repair or replace? A simple framework', body: 'Isolated damage + remaining service life = repair. Widespread damage, repeated leaks, or a roof past year 18–20 = get replacement pricing too, and compare total cost over ten years instead of this month.', href: '/services/roof-replacement' },
    { title: 'Why fast water response prevents mold', body: 'Mold needs 24–48 hours on wet material. Extraction and structural drying inside that window is the difference between a restoration bill and a remediation bill.', href: '/services/water-damage-restoration' },
  ];
  return (
    <div className="flex-1">
      <Seo
        title="Homeowner Resources — Roofing Guides"
        description="Plain-language roofing guides from Painless Roofing: storm damage, insurance claims, leaks, ventilation, and when to repair vs. replace."
        path="/resources"
        jsonLd={breadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: 'Resources', path: '/resources' }])}
      />
      <div className="container mx-auto px-4 max-w-5xl pt-10">
        <Breadcrumbs items={[{ name: 'Home', href: '/' }, { name: 'Resources' }]} />
      </div>
      <PageHero
        eyebrow="Resources"
        title="Know your roof before you need to."
        lede="Short, honest answers to the questions homeowners actually ask — no scare tactics, no jargon."
      />
      <section className="pb-16">
        <div className="container mx-auto px-4 max-w-5xl">
          <div className="grid sm:grid-cols-2 gap-5">
            {resources.map((r) => (
              <Link key={r.title} href={r.href} className="group p-7 rounded-3xl bg-card/40 border border-card-border hover:border-primary/40 transition-colors focus-visible:outline-2 focus-visible:outline-primary">
                <h2 className="font-display font-semibold text-white text-lg mb-3 group-hover:text-primary transition-colors">{r.title}</h2>
                <p className="text-sm text-muted-foreground leading-relaxed">{r.body}</p>
                <span className="mt-4 inline-flex items-center gap-1.5 text-primary text-sm font-medium">
                  Related service <ArrowRight aria-hidden className="w-4 h-4 group-hover:translate-x-1 transition-transform motion-reduce:transition-none" />
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>
      <CtaSection trackLabel="resources" />
    </div>
  );
}
