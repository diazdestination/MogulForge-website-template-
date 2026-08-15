import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { ArrowRight, HeartHandshake, MessageSquareQuote, Star, Wrench } from 'lucide-react';
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

function GalleryImage({ src, alt, srcSet, sizes }: { src: string; alt: string; srcSet?: string; sizes?: string }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  // Catch images that were already decoded before React attached the listener
  // (common for cached assets after hydration).
  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth > 0) {
      setLoaded(true);
    }
  }, []);

  // Derive JPEG fallback: swap .webp → .jpg; JPEGs are their own fallback
  const fallbackSrc = src.endsWith('.webp') ? src.replace(/\.webp$/, '.jpg') : src;
  const isWebp = src.endsWith('.webp');

  if (failed) {
    return (
      <div
        className="w-full h-full flex flex-col items-center justify-center gap-3 bg-gradient-to-br from-primary/20 to-primary/5"
        role="img"
        aria-label={alt}
      >
        {/* Brand logo mark */}
        <svg viewBox="0 0 40 36" className="w-10 h-10 text-primary/70" fill="currentColor" aria-hidden>
          <path d="M20 0 L40 18 L34 18 L34 36 L6 36 L6 18 L0 18 Z" />
        </svg>
        <span className="text-xs text-primary/50 font-medium tracking-wide uppercase">Painless Roofing</span>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full">
      {/* Skeleton shown until the image is ready or has errored */}
      {!loaded && (
        <div
          aria-hidden
          className="absolute inset-0 bg-gradient-to-br from-card/80 to-primary/10 animate-pulse"
        />
      )}
      <picture>
        {/* WebP source: use responsive size cuts when provided, else single WebP */}
        {(srcSet || isWebp) && (
          <source srcSet={srcSet ?? src} type="image/webp" sizes={sizes} />
        )}
        <img
          ref={imgRef}
          src={fallbackSrc}
          alt={alt}
          className={`w-full h-full object-cover group-hover:scale-105 transition-all duration-500 motion-reduce:transition-none ${loaded ? 'opacity-100' : 'opacity-0'}`}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => { setLoaded(true); setFailed(true); }}
        />
      </picture>
    </div>
  );
}

export function GalleryPage() {
  // Paths are relative so Vite's BASE_URL prefix is applied correctly under
  // both "/" and "/site/" deployments. Never use root-absolute "/gallery/…" here.
  const base = import.meta.env.BASE_URL; // always ends with "/"
  const projects = [
    { img: `${base}gallery/job-01.webp`, title: 'Architectural shingle replacement', where: 'Canton, GA', detail: 'Hail claim — complete tear-off, deck repairs on two slopes, ridge ventilation added.' },
    { img: `${base}gallery/job-02.webp`, title: 'Full roof replacement', where: 'Canton, GA', detail: 'Aerial view of completed system on a large two-story home — new shingles, flashing, and ridge cap throughout.' },
    { img: `${base}gallery/job-03.webp`, title: 'Close-detail shingle work', where: 'Cherokee County, GA', detail: 'Clean ridge line and uniform shingle layout; part of a full hail-damage restoration.' },
    { img: `${base}gallery/job-04.webp`, title: 'Storm damage restoration', where: 'Cumming, GA', detail: 'Post-storm assessment confirmed impact damage; tear-off and replacement completed within five days of claim approval.' },
    { img: `${base}gallery/job-05.webp`, title: 'Shingle replacement — large footprint', where: 'Canton, GA', detail: 'Multi-pitch home with complex valleys; all flashing replaced and sealed to manufacturer spec.' },
    { img: `${base}gallery/job-06.webp`, title: 'Complete tear-off and rebuild', where: 'Gainesville, GA', detail: 'Aging asphalt removed, decking inspected and spot-repaired, new 30-year architectural shingles installed.' },
    { img: `${base}gallery/job-07.webp`, title: 'Aerial — completed replacement', where: 'Dawsonville, GA', detail: 'Aerial shot on job completion day. Customer requested drone documentation for insurance records.' },
    { img: `${base}gallery/job-08.webp`, title: 'Residential re-roof', where: 'Alpharetta, GA', detail: 'HOA-approved shingle color; full perimeter drip edge replaced and all penetrations re-flashed.' },
    { img: `${base}gallery/job-09.webp`, title: 'Storm response — rapid replacement', where: 'Canton, GA', detail: 'Emergency tarped overnight after severe storm; full replacement completed by end of week.' },
    { img: `${base}gallery/job-10.webp`, title: 'Steep-pitch shingle work', where: 'Cherokee County, GA', detail: 'Safety-harnessed crew on a steep-pitch section; ice-and-water shield added at all eaves per code.' },
    { img: `${base}gallery/job-11.webp`, title: 'New roof — wooded lot', where: 'North Georgia', detail: 'Extra debris management on heavily wooded property; gutters cleaned and resealed on completion.' },
    { img: `${base}gallery/job-12.webp`, title: 'Full replacement — before & after', where: 'Canton, GA', detail: 'Replacement on a mid-sized ranch; new ventilation system added to extend the life of the new roof.' },
    { img: `${base}gallery/fb-job-01.jpg`, title: 'Full system — roof, gutters & standing seam metal', where: 'Canton, GA', detail: 'Travelers insurance covered a brand-new architectural shingle roof, complete gutter system, and standing seam metal sections after confirmed wind and hail damage. Duration shingles, ABC Supply materials.' },
    { img: `${base}gallery/fb-job-02.jpg`, title: 'Standing seam metal detail — insurance claim', where: 'Canton, GA', detail: 'Close-up of the standing seam metal sections on the same Travelers claim job. Clean seam lines and tight flashing transitions where metal meets shingle — a common failure point we address on every job.' },
    { img: `${base}gallery/fb-job-03.jpg`, title: 'Complete shingle replacement — Owens Corning', where: 'Canton, GA', detail: 'Full re-roof on a large two-story home using Owens Corning architectural shingles. New ventilation system and full perimeter drip edge included in the insurance scope.' },
    { img: `${base}gallery/metal-01.jpg`, title: 'Full charcoal metal roof — sunset aerial', where: 'Jasper, GA', detail: 'Complete corrugated standing seam metal installation at end-of-day. Dark charcoal finish chosen for longevity and curb appeal — metal roofs routinely outlast two shingle lifespans.' },
    { img: `${base}gallery/metal-02.jpg`, title: 'Standing seam metal — full replacement', where: 'Jasper, GA', detail: 'Charcoal corrugated metal over a home with a brick chimney. Chimney flashing and all penetrations sealed to manufacturer spec; same-day estimate preceded this install by less than a week.' },
    { img: `${base}gallery/metal-03.jpg`, title: 'Dark corrugated metal — wooded lot', where: 'Dahlonega, GA', detail: 'Tight ridge cap and clean panel alignment on a heavily wooded property. Metal was the right call here — low maintenance and no debris accumulation issues like asphalt on a shaded roof.' },
    { img: `${base}gallery/metal-04.jpg`, title: 'Rural property — full metal re-roof', where: 'Dawsonville, GA', detail: 'Dark brown corrugated metal on a rural home with rolling pasture behind it. Customer wanted a lifetime roof that matched the farmhouse aesthetic — competitive pricing, completed in two days.' },
    { img: `${base}gallery/metal-05.jpg`, title: 'White standing seam — multi-pitch home', where: 'Dawsonville, GA', detail: 'Bright white standing seam across multiple pitches with original brick chimney retained and re-flashed. Clean winter install — no weather delays, job finished in one continuous run.' },
    { img: `${base}gallery/metal-06.jpg`, title: 'Galvanized metal — farm structure', where: 'Jasper, GA', detail: 'Galvanized corrugated metal on a farm outbuilding. Durable, low-cost, and rated for decades of North Georgia weather. We bring the same care to agricultural and outbuilding work as to any home.' },
    { img: `${base}gallery/metal-07.jpg`, title: 'Metal porch roof — two-tone addition', where: 'North Georgia', detail: 'Dark charcoal metal porch cover added to match the main structure. We handle porch, carport, and addition roofing — not just full replacements. Same-day estimate, quick turnaround.' },
    { img: `${base}gallery/metal-08.jpg`, title: 'Standing seam install — in progress', where: 'Canton, GA', detail: 'Mid-installation view of new standing seam panels going down alongside the existing shingle field. Partial metal additions are a popular upgrade for porch sections and dormers.' },
    { img: `${base}gallery/metal-09.jpg`, title: 'Hybrid metal + shingle — section upgrade', where: 'Canton, GA', detail: 'Charcoal standing seam added to a flat/low-slope section where shingles were failing. Mixing materials on complex rooflines is a specialty — each transition is hand-detailed and sealed.' },
    { img: `${base}gallery/metal-10.jpg`, title: 'Light galvanized metal — full re-roof', where: 'North Georgia', detail: 'Light gray corrugated metal covering a full footprint just before dusk. Crew truck visible — this was a same-day completion. Metal installs move fast compared to shingle tear-offs.' },
    { img: `${base}gallery/fb-job-04.jpg`, title: 'Shingle replacement — Safeco claim, full coverage', where: 'Canton, GA', detail: 'This replacement was approved and covered by Safeco due to storm damage. We assisted with the inspection, submitted all required documentation, and worked directly with the adjuster — homeowner received the full benefit of their coverage.' },
    { img: `${base}gallery/fb-job-05.jpg`, title: 'Full shingle replacement — craftsman home', where: 'North Georgia', detail: 'Clean charcoal architectural shingles on a distinctive two-story craftsman. New ridge cap and chimney flashing throughout. Same-day estimate, completed in one run.' },
    { img: `${base}gallery/fb-job-06.jpg`, title: 'Shingle replacement — wooded lot, summer', where: 'Cherokee County, GA', detail: 'Dark charcoal architectural shingles on a home surrounded by mature hardwoods. Chimney re-flashed and sealed. Debris management included — wooded lots require extra cleanup on every visit.' },
    { img: `${base}gallery/damage-01.jpg`, title: 'Why we get called — Talking Rock hailstorm', where: 'Talking Rock, GA', detail: 'Golf-ball and larger hail fell in Talking Rock — a local resident documented stones spanning a full hand. Hail this size leaves impact craters on every exposed shingle surface. Call us within 24 hours of a storm like this.' },
    { img: `${base}gallery/damage-02.jpg`, title: 'Active roof failure — water intrusion after hail', where: 'Talking Rock, GA', detail: 'Hailstones streaming through a compromised ceiling into a living room — documented the same night as the storm. This is exactly what we prevent: emergency tarping within hours, water restoration started the next morning.' },
    { img: `${base}gallery/before-after-01-before.jpg`, title: 'Before — aged shingles, storm damage confirmed', where: 'North Georgia', detail: 'The old roof before our free inspection. Storm-related damage was confirmed, documented, and submitted to insurance. Tarp staged on-site while the claim was processed — homeowner paid $0 out of pocket.' },
    { img: `${base}gallery/before-after-01-after.jpg`, title: 'After — $0 out-of-pocket insurance replacement', where: 'North Georgia', detail: 'Finished light gray architectural shingles on the same home. Free inspection → insurance approval → complete replacement, all handled by our team. This homeowner never wrote a check.' },
  ];
  return (
    <div className="flex-1">
      <Seo
        title="Project Gallery — Recent Roofing Work"
        description="Photos from real completed roofing and restoration projects by Painless Roofing & Water Restoration across Canton, Gainesville, Cumming, and North Georgia."
        path="/gallery"
        jsonLd={breadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: 'Project Gallery', path: '/gallery' }])}
      />
      <div className="container mx-auto px-4 max-w-5xl pt-10">
        <Breadcrumbs items={[{ name: 'Home', href: '/' }, { name: 'Project Gallery' }]} />
      </div>
      <PageHero
        eyebrow="Project Gallery"
        title="Real jobs. Real roofs. No stock photos."
        lede="Photos from completed projects across our North Georgia service area. Every image is from an actual job site."
      />
      <section className="pb-16">
        <div className="container mx-auto px-4 max-w-6xl">
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {projects.map((p) => {
              // Derive the stem (strip extension) to build responsive WebP srcset paths.
              // p.img is e.g. `${base}gallery/job-02.webp` or `…/fb-job-01.jpg`
              const stem = p.img.replace(/\.[^.]+$/, '');
              return (
                <div key={p.img} className="rounded-2xl overflow-hidden bg-card/40 border border-card-border flex flex-col group">
                  <div className="aspect-[4/3] overflow-hidden">
                    <GalleryImage
                      src={p.img}
                      alt={`${p.title} — ${p.where}`}
                      srcSet={`${stem}-400.webp 400w, ${stem}-800.webp 800w`}
                      sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                    />
                  </div>
                  <div className="p-5 flex flex-col flex-1">
                    <h2 className="font-display font-semibold text-white text-base mb-1">{p.title}</h2>
                    <p className="text-xs uppercase tracking-wider text-primary/80 mb-2">{p.where}</p>
                    <p className="text-sm text-muted-foreground leading-relaxed">{p.detail}</p>
                  </div>
                </div>
              );
            })}
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
