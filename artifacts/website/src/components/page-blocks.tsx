import React from 'react';
import { Link } from 'wouter';
import { ArrowRight, ChevronRight, Phone } from 'lucide-react';
import { motion } from 'framer-motion';
import { useAnalytics } from '@/lib/analytics';
import { useBusiness } from '@/lib/site-config';

export function Breadcrumbs({ items }: { items: Array<{ name: string; href?: string }> }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-8">
      <ol className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
        {items.map((item, i) => (
          <li key={i} className="flex items-center gap-1.5">
            {i > 0 && <ChevronRight aria-hidden className="w-3.5 h-3.5 text-muted-foreground/40" />}
            {item.href && i < items.length - 1 ? (
              <Link href={item.href} className="hover:text-primary transition-colors rounded focus-visible:outline-2 focus-visible:outline-primary">
                {item.name}
              </Link>
            ) : (
              <span aria-current="page" className="text-foreground/80">{item.name}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function PageHero({ eyebrow, title, lede, children }: { eyebrow?: string; title: React.ReactNode; lede?: string; children?: React.ReactNode }) {
  return (
    <div className="relative pt-16 pb-12 md:pt-20 md:pb-16 overflow-hidden">
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-primary/8 rounded-full blur-[120px] pointer-events-none motion-reduce:hidden" aria-hidden />
      <div className="container mx-auto px-4 relative z-10 max-w-4xl">
        {eyebrow && (
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary mb-4">{eyebrow}</p>
        )}
        <motion.h1
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="text-4xl md:text-6xl font-display font-bold tracking-tight mb-6 leading-[1.08] motion-reduce:transition-none"
        >
          {title}
        </motion.h1>
        {lede && <p className="text-lg md:text-xl text-muted-foreground leading-relaxed max-w-3xl">{lede}</p>}
        {children}
      </div>
    </div>
  );
}

export function CtaSection({ heading, sub, primaryLabel = 'Start My Roof Assessment', primaryHref = '/assessment', trackLabel }: { heading?: string; sub?: string; primaryLabel?: string; primaryHref?: string; trackLabel: string }) {
  const BUSINESS = useBusiness();
  const { track } = useAnalytics();
  return (
    <section className="py-20 border-t border-white/5 bg-card/20">
      <div className="container mx-auto px-4 max-w-3xl text-center">
        <h2 className="text-3xl md:text-4xl font-display font-bold mb-4">
          {heading ?? 'Ready for a straight answer about your roof?'}
        </h2>
        <p className="text-lg text-muted-foreground mb-10">
          {sub ?? 'Start a free assessment online, or call and talk to a person — 24 hours a day, 7 days a week.'}
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link
            href={primaryHref}
            onClick={() => track('cta_clicked', { label: `${trackLabel}_primary` })}
            className="w-full sm:w-auto px-8 py-4 bg-primary text-primary-foreground font-semibold rounded-xl hover:bg-accent transition-colors flex items-center justify-center gap-2 text-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {primaryLabel}
            <ArrowRight aria-hidden className="w-5 h-5" />
          </Link>
          <a
            href={BUSINESS.phoneHref}
            onClick={() => track('phone_clicked', { label: `${trackLabel}_phone` })}
            className="w-full sm:w-auto px-8 py-4 bg-white/5 text-white font-semibold rounded-xl border border-white/10 hover:bg-white/10 transition-colors flex items-center justify-center gap-2 text-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <Phone aria-hidden className="w-5 h-5 text-primary" />
            {BUSINESS.phone}
          </a>
        </div>
      </div>
    </section>
  );
}

export function SectionHeading({ children, sub }: { children: React.ReactNode; sub?: string }) {
  return (
    <div className="mb-10">
      <h2 className="text-2xl md:text-4xl font-display font-bold mb-3">{children}</h2>
      {sub && <p className="text-lg text-muted-foreground max-w-2xl">{sub}</p>}
    </div>
  );
}

export function FaqList({ faqs }: { faqs: Array<{ question: string; answer: string }> }) {
  return (
    <div className="space-y-4">
      {faqs.map((faq) => (
        <details key={faq.question} className="group rounded-2xl bg-card/50 border border-card-border open:border-primary/30 transition-colors">
          <summary className="cursor-pointer list-none p-6 flex items-center justify-between gap-4 text-lg font-medium text-white rounded-2xl focus-visible:outline-2 focus-visible:outline-primary">
            {faq.question}
            <ChevronRight aria-hidden className="w-5 h-5 text-muted-foreground shrink-0 transition-transform group-open:rotate-90" />
          </summary>
          <p className="px-6 pb-6 text-muted-foreground leading-relaxed">{faq.answer}</p>
        </details>
      ))}
    </div>
  );
}
