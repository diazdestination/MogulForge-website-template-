import { Link } from 'wouter';
import { useAnalytics } from '@/lib/analytics';
import {
  ArrowRight, BadgeCheck, ClipboardCheck, Clock, CloudLightning, Droplets, FileCheck2,
  HardHat, Home, MapPin, MessageCircle, Phone, Search, ShieldAlert, Star, Users,
} from 'lucide-react';
import { GoogleReviewCta } from '@/components/google-review-cta';
import { motion } from 'framer-motion';
import { Seo, faqJsonLd, localBusinessJsonLd } from '@/lib/seo';
import { FaqList, SectionHeading } from '@/components/page-blocks';
import { useSiteConfig } from '@/lib/site-config';
import { useReviews } from '@/lib/use-reviews';

const HOME_FAQS = [
  { question: 'Do you really answer the phone 24/7?', answer: 'Yes — we are open 24 hours, Monday through Sunday. Active leaks and storm damage get worse by the hour, so a real person answers whenever you call.' },
  { question: 'Is the online assessment really free?', answer: 'Yes. The assessment and any resulting inspection recommendation are free, with no obligation. If your roof is fine, we tell you it is fine.' },
  { question: 'Do you work with insurance companies?', answer: 'Every week. We document damage the way adjusters expect and can meet your adjuster on site. We never guarantee claim outcomes — coverage decisions belong to your insurer — but we make sure legitimate damage is properly represented.' },
  { question: 'What areas do you serve?', answer: 'We are based in Canton, GA and serve Cherokee County plus Atlanta, Dawsonville, Cumming, Alpharetta, Gainesville, and the surrounding North Georgia communities.' },
  { question: 'Are you licensed and insured?', answer: 'Yes — fully licensed and insured, and family-owned. You get quality materials, clear communication, and honest assessments on every job.' },
];

export default function HomePage() {
  const { track } = useAnalytics();
  const { business: BUSINESS, services: SERVICES, areas: AREAS } = useSiteConfig();
  const { reviews } = useReviews();

  return (
    <div className="flex-1 flex flex-col">
      <Seo
        title={`${BUSINESS.name} | Roofing & Restoration in Canton, GA`}
        description="Family-owned roofing and water damage restoration in Canton, GA and North Georgia. Storm damage, repair, replacement, and insurance claim help — open 24 hours. Call (404) 444-4476."
        path="/"
        jsonLd={[localBusinessJsonLd(BUSINESS), faqJsonLd(HOME_FAQS)]}
      />

      {/* Hero */}
      <section className="relative pt-24 pb-28 overflow-hidden">
        {/* Real job photo background — mobile gets the 800px WebP, desktop gets 1440px */}
        <div
          className="absolute inset-0 bg-cover bg-center bg-no-repeat md:hidden"
          style={{ backgroundImage: `url(${import.meta.env.BASE_URL}gallery/fb-job-01-800.webp)` }}
          aria-hidden
        />
        <div
          className="absolute inset-0 bg-cover bg-center bg-no-repeat hidden md:block"
          style={{ backgroundImage: `url(${import.meta.env.BASE_URL}gallery/fb-job-01-1440.webp)` }}
          aria-hidden
        />
        {/* Dark overlay so text stays legible */}
        <div className="absolute inset-0 bg-background/80" aria-hidden />
        <div className="container mx-auto px-4 relative z-10">
          <div className="max-w-4xl mx-auto text-center">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
              className="inline-flex flex-col items-center mb-10 motion-reduce:transition-none"
            >
              <div className="px-5 py-2 rounded-full border border-primary/20 bg-primary/5 backdrop-blur-md flex items-center gap-2 mb-3 shadow-[0_0_15px_rgba(56,189,248,0.1)]">
                <span className="text-sm font-medium text-primary">{BUSINESS.name}</span>
              </div>
              <span className="text-[11px] text-muted-foreground uppercase tracking-[0.2em] font-semibold">Canton, GA · Licensed &amp; Insured · Family-Owned</span>
            </motion.div>

            <motion.h1
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
              className="text-5xl md:text-7xl lg:text-8xl font-display font-bold tracking-tight mb-8 leading-[1.1] motion-reduce:transition-none"
            >
              Your home took the hit.<br />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-white via-primary to-accent">
                We'll make recovery painless.
              </span>
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className="text-lg md:text-xl text-muted-foreground mb-12 max-w-2xl mx-auto leading-relaxed motion-reduce:transition-none"
            >
              Upload damage photos, check your property for recent storm activity, get immediate guidance, and schedule a professional roof inspection.
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}
              className="flex flex-col sm:flex-row flex-wrap items-center justify-center gap-4 motion-reduce:transition-none"
            >
              <Link
                href="/assessment"
                onClick={() => track('cta_clicked', { label: 'hero_primary' })}
                className="w-full sm:w-auto px-8 py-4 bg-primary text-primary-foreground font-semibold rounded-xl hover:bg-accent transition-colors flex items-center justify-center gap-2 shadow-[0_0_30px_rgba(56,189,248,0.3)] text-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                Start My Roof Assessment
                <ArrowRight aria-hidden className="w-5 h-5" />
              </Link>
              <Link
                href="/assessment?intent=emergency"
                onClick={() => track('cta_clicked', { label: 'hero_emergency' })}
                className="w-full sm:w-auto px-8 py-4 bg-destructive/10 text-red-400 font-semibold rounded-xl border border-destructive/20 hover:bg-destructive/20 hover:border-destructive/40 transition-colors flex items-center justify-center gap-2 text-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                I Have an Emergency
              </Link>
              <Link
                href="/storm-check"
                onClick={() => track('cta_clicked', { label: 'hero_storm_check' })}
                className="w-full sm:w-auto px-8 py-4 bg-white/5 text-white font-semibold rounded-xl border border-white/10 hover:bg-white/10 transition-colors flex items-center justify-center gap-2 text-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                <CloudLightning aria-hidden className="w-5 h-5 text-primary" />
                Check My Address
              </Link>
              <Link
                href="/concierge"
                onClick={() => track('cta_clicked', { label: 'hero_concierge' })}
                className="w-full sm:w-auto px-8 py-4 bg-white/5 text-white font-semibold rounded-xl border border-white/10 hover:border-primary/40 hover:bg-white/10 transition-colors flex items-center justify-center gap-2 text-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                <MessageCircle aria-hidden className="w-5 h-5 text-primary" />
                Talk to the AI Roof Concierge
              </Link>
            </motion.div>

            {/* Trust indicators */}
            <motion.ul
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.6, delay: 0.5 }}
              className="mt-12 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-sm text-muted-foreground motion-reduce:transition-none"
            >
              {[
                { icon: Users, label: 'Family-owned' },
                { icon: BadgeCheck, label: 'Licensed & insured' },
                { icon: Clock, label: 'Open 24 hours, 7 days' },
                { icon: MapPin, label: 'Based in Canton, GA' },
              ].map((t) => (
                <li key={t.label} className="flex items-center gap-2">
                  <t.icon aria-hidden className="w-4 h-4 text-primary" /> {t.label}
                </li>
              ))}
            </motion.ul>

            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.6, delay: 0.6 }}
              className="mt-8 text-xs text-muted-foreground/50 max-w-sm mx-auto motion-reduce:transition-none"
            >
              Online guidance does not replace an on-site professional inspection.
            </motion.p>
          </div>
        </div>
      </section>

      {/* Pathways */}
      <section className="py-28 bg-card/20 border-t border-white/5 relative z-10">
        <div className="container mx-auto px-4 max-w-6xl">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-5xl font-display font-bold mb-6">What brought you here?</h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">Select your situation to get the right guidance immediately.</p>
          </div>

          <div className="grid md:grid-cols-2 gap-6 lg:gap-8">
            <PathwayCard icon={<ShieldAlert aria-hidden className="w-8 h-8 text-orange-400" />} iconBg="bg-orange-400/10" title="Active Roof Leak" description="Get immediate guidance and request priority assistance." href="/assessment?intent=active-leak" delay={0.1} />
            <PathwayCard icon={<CloudLightning aria-hidden className="w-8 h-8 text-primary" />} iconBg="bg-primary/10" title="Recent Storm" description="Check your address and document possible wind or hail impact." href="/storm-check" delay={0.2} />
            <PathwayCard icon={<Home aria-hidden className="w-8 h-8 text-indigo-400" />} iconBg="bg-indigo-400/10" title="Roof Replacement" description="Explore replacement options and schedule a professional inspection." href="/assessment?intent=replacement" delay={0.3} />
            <PathwayCard icon={<Droplets aria-hidden className="w-8 h-8 text-cyan-400" />} iconBg="bg-cyan-400/10" title="Water Damage" description="Start an emergency intake for active water intrusion." href="/assessment?intent=water-damage" delay={0.4} />
          </div>
        </div>
      </section>

      {/* Services */}
      <section className="py-24 border-t border-white/5">
        <div className="container mx-auto px-4 max-w-6xl">
          <SectionHeading sub="Thirteen services, one standard — from a single shingle to a full storm restoration.">Everything above your walls</SectionHeading>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {SERVICES.slice(0, 8).map((s) => (
              <Link key={s.slug} href={`/services/${s.slug}`} className="group p-6 rounded-2xl bg-card/40 border border-card-border hover:border-primary/40 transition-colors focus-visible:outline-2 focus-visible:outline-primary">
                <s.icon aria-hidden className="w-6 h-6 text-primary mb-4" />
                <div className="font-semibold text-white group-hover:text-primary transition-colors mb-1">{s.name}</div>
                <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">{s.teaser}</p>
              </Link>
            ))}
          </div>
          <div className="mt-8 text-center">
            <Link href="/services" onClick={() => track('cta_clicked', { label: 'home_all_services' })} className="inline-flex items-center gap-2 text-primary font-medium hover:underline focus-visible:outline-2 focus-visible:outline-primary rounded">
              View all 13 services <ArrowRight aria-hidden className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </section>

      {/* Process */}
      <section className="py-24 border-t border-white/5 bg-card/10">
        <div className="container mx-auto px-4 max-w-5xl">
          <SectionHeading sub="No mystery, no pressure — you know what happens next at every step.">How recovery works</SectionHeading>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {[
              { icon: Search, title: '1. Assess', body: 'Start online or call. We look at photos, storm data, and your situation to gauge urgency honestly.' },
              { icon: ClipboardCheck, title: '2. Inspect', body: 'A professional inspection with photo documentation — and a straight answer, even if that answer is "your roof is fine."' },
              { icon: FileCheck2, title: '3. Plan & insurance', body: 'Clear scope and pricing. If a storm caused it, we document everything your insurance claim needs.' },
              { icon: HardHat, title: '4. Restore', body: 'Quality materials, clean job sites, and a final walkthrough with you before we call it done.' },
            ].map((step) => (
              <div key={step.title} className="p-7 rounded-3xl bg-card/40 border border-card-border">
                <step.icon aria-hidden className="w-7 h-7 text-primary mb-4" />
                <h3 className="font-display font-semibold text-white text-lg mb-2">{step.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{step.body}</p>
              </div>
            ))}
          </div>
          <div className="mt-10 p-6 rounded-2xl bg-primary/5 border border-primary/15 flex flex-col sm:flex-row items-center justify-between gap-4">
            <p className="text-muted-foreground">
              <strong className="text-white">Dealing with insurance?</strong> We document damage properly and meet your adjuster — without promising outcomes nobody can promise.
            </p>
            <Link href="/services/insurance-claims" className="shrink-0 inline-flex items-center gap-2 text-primary font-medium hover:underline">
              How claims work <ArrowRight aria-hidden className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </section>

      {/* Reviews excerpt */}
      <section className="py-24 border-t border-white/5">
        <div className="container mx-auto px-4 max-w-5xl">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-12">
            <div>
              <p className="text-sm font-semibold uppercase tracking-widest text-primary mb-3">Reviews</p>
              <h2 className="text-3xl md:text-5xl font-display font-bold">Homeowners put it better than we can</h2>
            </div>
            {/* Google rating badge */}
            <div className="shrink-0 flex items-center gap-3 px-5 py-3 rounded-2xl bg-card/50 border border-card-border">
              {/* Google "G" mark */}
              <svg aria-hidden viewBox="0 0 24 24" className="w-5 h-5 shrink-0" fill="none">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              <div className="flex flex-col">
                <div className="flex items-center gap-1.5">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Star key={i} aria-hidden className="w-3.5 h-3.5 text-yellow-400 fill-yellow-400" />
                  ))}
                </div>
                <span className="text-xs text-muted-foreground mt-0.5">5.0 · Google Reviews</span>
              </div>
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-5">
            {reviews.map((r) => (
              <figure key={r.who + r.quote.slice(0, 16)} className="p-7 rounded-3xl bg-card/40 border border-card-border flex flex-col">
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

          <div className="mt-8 text-center">
            <Link href="/reviews" className="inline-flex items-center gap-2 text-primary font-medium hover:underline focus-visible:outline-2 focus-visible:outline-primary rounded">
              Read all reviews <ArrowRight aria-hidden className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </section>

      {/* Service areas */}
      <section className="py-24 border-t border-white/5 bg-card/10">
        <div className="container mx-auto px-4 max-w-5xl">
          <SectionHeading sub="Based in Canton, GA — but we'll go wherever the job is.">Where we work</SectionHeading>
          <div className="flex flex-wrap gap-3">
            {AREAS.map((a) => (
              <Link key={a.slug} href={`/service-areas/${a.slug}`} className="px-5 py-3 rounded-full bg-card/50 border border-card-border hover:border-primary/40 text-foreground/90 hover:text-primary transition-colors flex items-center gap-2 focus-visible:outline-2 focus-visible:outline-primary">
                <MapPin aria-hidden className="w-4 h-4 text-primary" /> {a.city}, GA
              </Link>
            ))}
          </div>
          <p className="mt-8 text-sm text-foreground/60 leading-relaxed max-w-2xl">
            We're based in Canton, GA and serve North Georgia communities every day — but we're not limited to the Southeast. We travel to any state in the Continental United States for roofing and water damage restoration work. Large loss, commercial project, or anything that needs a crew that will show up and do the job right: <a href="/contact" className="text-primary hover:underline underline-offset-4">call us</a>.
          </p>
          <div className="mt-4">
            <Link href="/nationwide" className="inline-flex items-center gap-2 text-sm text-primary font-medium hover:underline focus-visible:outline-2 focus-visible:outline-primary rounded">
              Learn about our nationwide coverage <ArrowRight aria-hidden className="w-3.5 h-3.5" />
            </Link>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="py-24 border-t border-white/5">
        <div className="container mx-auto px-4 max-w-4xl">
          <SectionHeading>Frequently asked questions</SectionHeading>
          <FaqList faqs={HOME_FAQS} />
        </div>
      </section>

      {/* Final conversion */}
      <section className="py-28 border-t border-white/5 bg-gradient-to-b from-card/20 to-primary/5">
        <div className="container mx-auto px-4 max-w-3xl text-center">
          <h2 className="text-4xl md:text-5xl font-display font-bold mb-6">Storm damage doesn't fix itself.</h2>
          <p className="text-xl text-muted-foreground mb-10">Get a straight answer about your roof today — free assessment online, or a real person on the phone 24/7.</p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              href="/assessment"
              onClick={() => track('cta_clicked', { label: 'home_final_primary' })}
              className="w-full sm:w-auto px-8 py-4 bg-primary text-primary-foreground font-semibold rounded-xl hover:bg-accent transition-colors flex items-center justify-center gap-2 text-lg shadow-[0_0_30px_rgba(56,189,248,0.3)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              Start My Free Assessment <ArrowRight aria-hidden className="w-5 h-5" />
            </Link>
            <a
              href={BUSINESS.phoneHref}
              onClick={() => track('phone_clicked', { label: 'home_final' })}
              className="w-full sm:w-auto px-8 py-4 bg-white/5 text-white font-semibold rounded-xl border border-white/10 hover:bg-white/10 transition-colors flex items-center justify-center gap-2 text-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <Phone aria-hidden className="w-5 h-5 text-primary" /> {BUSINESS.phone}
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}

function PathwayCard({ icon, iconBg, title, description, href, delay }: { icon: React.ReactNode, iconBg: string, title: string, description: string, href: string, delay: number }) {
  const { track } = useAnalytics();

  return (
    <motion.div
      initial={{ opacity: 0, y: 30 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-100px" }}
      transition={{ duration: 0.6, delay, ease: [0.16, 1, 0.3, 1] }}
      className="h-full motion-reduce:transition-none"
    >
      <Link
        href={href}
        onClick={() => track('cta_clicked', { label: `pathway_${title.toLowerCase().replace(/\s+/g, '_')}` })}
        className="group flex flex-col p-8 md:p-10 rounded-3xl bg-card/50 border border-card-border hover:border-primary/40 hover:bg-card/80 transition-colors duration-500 h-full backdrop-blur-sm focus-visible:outline-2 focus-visible:outline-primary"
      >
        <div className={`w-16 h-16 rounded-2xl ${iconBg} border border-white/5 flex items-center justify-center mb-8 group-hover:scale-110 transition-transform duration-500 motion-reduce:transition-none`} aria-hidden>
          {icon}
        </div>
        <h3 className="text-2xl font-display font-semibold mb-4 text-white group-hover:text-primary transition-colors">{title}</h3>
        <p className="text-muted-foreground text-lg leading-relaxed flex-1">{description}</p>
        <div className="mt-8 flex items-center text-primary font-medium text-base gap-2 opacity-0 -translate-x-4 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-300 motion-reduce:opacity-100 motion-reduce:translate-x-0">
          Get Started <ArrowRight aria-hidden className="w-5 h-5" />
        </div>
      </Link>
    </motion.div>
  );
}
