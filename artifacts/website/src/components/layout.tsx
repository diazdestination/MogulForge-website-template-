import React, { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { ChevronDown, Menu, Phone, X } from 'lucide-react';
import { useAnalytics } from '@/lib/analytics';
import { useSiteConfig } from '@/lib/site-config';
import { AmbientLighting } from '@/components/ambient-lighting';
import logoUrl from '@/assets/logo.png';

const NAV_LINKS = [
  { label: 'About', href: '/about' },
  { label: 'Gallery', href: '/gallery' },
  { label: 'Reviews', href: '/reviews' },
  { label: 'Resources', href: '/resources' },
  { label: 'Contact', href: '/contact' },
];

function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-3">
      <img src={logoUrl} alt="" width={80} height={80} className={compact ? 'w-14 h-14' : 'w-20 h-20'} loading="eager" />
      <span className="flex flex-col">
        <span className="font-display font-bold text-xl leading-none tracking-tight text-white">Painless</span>
        {!compact && (
          <span className="text-[10px] text-muted-foreground uppercase tracking-widest leading-none font-medium mt-1">
            Roofing & Restoration
          </span>
        )}
      </span>
    </span>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const { track } = useAnalytics();
  const { business: BUSINESS, services: SERVICES, areas: AREAS } = useSiteConfig();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [location] = useLocation();

  // Close the mobile menu on navigation.
  React.useEffect(() => setMobileOpen(false), [location]);

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background text-foreground font-sans selection:bg-primary/30">
      <AmbientLighting />
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[100] focus:px-4 focus:py-2 focus:bg-primary focus:text-primary-foreground focus:rounded-lg">
        Skip to content
      </a>

      <header className="sticky top-0 z-50 w-full border-b border-white/5 bg-background/85 backdrop-blur-xl">
        <div className="container mx-auto px-4 h-20 flex items-center justify-between gap-4">
          <Link href="/" aria-label="Painless Roofing & Water Restoration — home" className="rounded-lg focus-visible:outline-2 focus-visible:outline-primary">
            <Wordmark />
          </Link>

          <nav aria-label="Main" className="hidden lg:flex items-center gap-1">
            <div className="relative group">
              <Link
                href="/services"
                className="px-4 py-2 rounded-lg text-sm font-medium text-foreground/80 hover:text-white hover:bg-white/5 transition-colors flex items-center gap-1 focus-visible:outline-2 focus-visible:outline-primary"
              >
                Services <ChevronDown aria-hidden className="w-3.5 h-3.5" />
              </Link>
              <div className="absolute top-full left-0 pt-2 opacity-0 invisible group-hover:opacity-100 group-hover:visible group-focus-within:opacity-100 group-focus-within:visible transition-all">
                <div className="w-[560px] p-4 rounded-2xl bg-card border border-card-border shadow-2xl grid grid-cols-2 gap-1">
                  {SERVICES.map((s) => (
                    <Link key={s.slug} href={`/services/${s.slug}`} className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/5 transition-colors focus-visible:outline-2 focus-visible:outline-primary">
                      <s.icon aria-hidden className="w-4 h-4 text-primary shrink-0" />
                      <span className="text-sm text-foreground/90">{s.name}</span>
                    </Link>
                  ))}
                </div>
              </div>
            </div>
            <div className="relative group">
              <Link
                href="/service-areas"
                className="px-4 py-2 rounded-lg text-sm font-medium text-foreground/80 hover:text-white hover:bg-white/5 transition-colors flex items-center gap-1 focus-visible:outline-2 focus-visible:outline-primary"
              >
                Areas <ChevronDown aria-hidden className="w-3.5 h-3.5" />
              </Link>
              <div className="absolute top-full left-0 pt-2 opacity-0 invisible group-hover:opacity-100 group-hover:visible group-focus-within:opacity-100 group-focus-within:visible transition-all">
                <div className="w-56 p-3 rounded-2xl bg-card border border-card-border shadow-2xl flex flex-col gap-1">
                  {AREAS.map((a) => (
                    <Link key={a.slug} href={`/service-areas/${a.slug}`} className="px-3 py-2 rounded-xl text-sm text-foreground/90 hover:bg-white/5 transition-colors focus-visible:outline-2 focus-visible:outline-primary">
                      {a.city}, {BUSINESS.state}
                    </Link>
                  ))}
                </div>
              </div>
            </div>
            {NAV_LINKS.map((link) => (
              <Link key={link.href} href={link.href} className="px-4 py-2 rounded-lg text-sm font-medium text-foreground/80 hover:text-white hover:bg-white/5 transition-colors focus-visible:outline-2 focus-visible:outline-primary">
                {link.label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-3">
            <a
              href={BUSINESS.phoneHref}
              onClick={() => track('phone_clicked', { label: 'nav_phone' })}
              className="hidden md:flex items-center gap-2 px-5 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 transition-colors border border-white/5 font-medium text-sm text-white focus-visible:outline-2 focus-visible:outline-primary"
            >
              <Phone aria-hidden className="w-4 h-4 text-primary" />
              {BUSINESS.phone}
            </a>
            <Link
              href="/assessment"
              onClick={() => track('cta_clicked', { label: 'nav_assessment' })}
              className="hidden sm:flex px-5 py-2.5 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:bg-accent transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              Free Assessment
            </Link>
            <button
              type="button"
              onClick={() => setMobileOpen((v) => !v)}
              aria-expanded={mobileOpen}
              aria-controls="mobile-nav"
              aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
              className="lg:hidden p-2.5 rounded-xl bg-white/5 border border-white/5 text-white focus-visible:outline-2 focus-visible:outline-primary"
            >
              {mobileOpen ? <X aria-hidden className="w-5 h-5" /> : <Menu aria-hidden className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {mobileOpen && (
          <nav id="mobile-nav" aria-label="Mobile" className="lg:hidden border-t border-white/5 bg-background/95 backdrop-blur-xl max-h-[calc(100dvh-5rem)] overflow-y-auto">
            <div className="container mx-auto px-4 py-6 grid gap-6">
              <div>
                <p className="text-xs uppercase tracking-widest text-muted-foreground mb-2 font-semibold">Services</p>
                <div className="grid grid-cols-2 gap-1">
                  {SERVICES.map((s) => (
                    <Link key={s.slug} href={`/services/${s.slug}`} className="px-3 py-2.5 rounded-xl text-sm text-foreground/90 hover:bg-white/5">
                      {s.name}
                    </Link>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs uppercase tracking-widest text-muted-foreground mb-2 font-semibold">Service Areas</p>
                <div className="grid grid-cols-2 gap-1">
                  {AREAS.map((a) => (
                    <Link key={a.slug} href={`/service-areas/${a.slug}`} className="px-3 py-2.5 rounded-xl text-sm text-foreground/90 hover:bg-white/5">
                      {a.city}, {BUSINESS.state}
                    </Link>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-1">
                {[{ label: 'Storm Check', href: '/storm-check' }, ...NAV_LINKS].map((link) => (
                  <Link key={link.href} href={link.href} className="px-3 py-2.5 rounded-xl text-sm text-foreground/90 hover:bg-white/5">
                    {link.label}
                  </Link>
                ))}
              </div>
              <Link href="/assessment" className="h-12 flex items-center justify-center bg-primary text-primary-foreground font-semibold rounded-xl">
                Start Free Assessment
              </Link>
            </div>
          </nav>
        )}
      </header>

      <main id="main-content" className="flex-1 flex flex-col relative z-10">
        {children}
      </main>

      {/* Sticky mobile call bar */}
      <div className="sm:hidden sticky bottom-0 z-40 p-3 bg-background/90 backdrop-blur-xl border-t border-white/10">
        <a
          href={BUSINESS.phoneHref}
          onClick={() => track('phone_clicked', { label: 'sticky_mobile' })}
          className="h-12 flex items-center justify-center gap-2 bg-primary text-primary-foreground font-semibold rounded-xl"
        >
          <Phone aria-hidden className="w-5 h-5" /> Call {BUSINESS.phone} — 24/7
        </a>
      </div>

      <footer className="py-16 border-t border-white/5 bg-background/50 relative z-10">
        <div className="container mx-auto px-4">
          <div className="grid gap-10 md:grid-cols-4 mb-12">
            <div>
              <Link href="/" className="inline-block mb-4 rounded-lg focus-visible:outline-2 focus-visible:outline-primary">
                <Wordmark compact />
              </Link>
              <p className="text-sm text-muted-foreground/70 leading-relaxed mb-4">{BUSINESS.tagline}</p>
              <p className="text-sm text-muted-foreground">
                {BUSINESS.city}, {BUSINESS.state} {BUSINESS.postalCode}
                <br />
                {BUSINESS.hours}
                <br />
                <a href={BUSINESS.phoneHref} onClick={() => track('phone_clicked', { label: 'footer' })} className="text-primary hover:underline">
                  {BUSINESS.phone}
                </a>
              </p>
            </div>
            <nav aria-label="Footer services">
              <p className="text-sm font-semibold text-white mb-3">Services</p>
              <ul className="space-y-2">
                {SERVICES.slice(0, 8).map((s) => (
                  <li key={s.slug}>
                    <Link href={`/services/${s.slug}`} className="text-sm text-muted-foreground hover:text-primary transition-colors">
                      {s.name}
                    </Link>
                  </li>
                ))}
                <li>
                  <Link href="/services" className="text-sm text-primary hover:underline">All services →</Link>
                </li>
              </ul>
            </nav>
            <nav aria-label="Footer areas and tools">
              <p className="text-sm font-semibold text-white mb-3">Areas & Tools</p>
              <ul className="space-y-2">
                {AREAS.map((a) => (
                  <li key={a.slug}>
                    <Link href={`/service-areas/${a.slug}`} className="text-sm text-muted-foreground hover:text-primary transition-colors">
                      Roofing in {a.city}, {BUSINESS.state}
                    </Link>
                  </li>
                ))}
                <li><Link href="/storm-check" className="text-sm text-muted-foreground hover:text-primary transition-colors">Storm Address Checker</Link></li>
                <li><Link href="/assessment" className="text-sm text-muted-foreground hover:text-primary transition-colors">Roof Assessment</Link></li>
                <li><Link href="/portal" className="text-sm text-muted-foreground hover:text-primary transition-colors">Claim Portal</Link></li>
                <li><Link href="/nationwide" className="text-sm text-muted-foreground hover:text-primary transition-colors">Nationwide Coverage</Link></li>
              </ul>
            </nav>
            <nav aria-label="Footer company">
              <p className="text-sm font-semibold text-white mb-3">Company</p>
              <ul className="space-y-2">
                {[
                  { label: 'About Us', href: '/about' },
                  { label: 'Project Gallery', href: '/gallery' },
                  { label: 'Reviews', href: '/reviews' },
                  { label: 'Financing', href: '/financing' },
                  { label: 'Resources', href: '/resources' },
                  { label: 'Contact', href: '/contact' },
                ].map((l) => (
                  <li key={l.href}>
                    <Link href={l.href} className="text-sm text-muted-foreground hover:text-primary transition-colors">{l.label}</Link>
                  </li>
                ))}
                <li>
                  <a href={BUSINESS.facebook} target="_blank" rel="noopener noreferrer" className="text-sm text-muted-foreground hover:text-primary transition-colors">Facebook</a>
                </li>
              </ul>
            </nav>
          </div>
          <div className="pt-8 border-t border-white/5 flex flex-col md:flex-row items-center justify-between gap-4">
            <p className="text-muted-foreground/40 text-xs">
              &copy; {new Date().getFullYear()} {BUSINESS.name}. Licensed & insured. All rights reserved. Powered by{' '}
              <span className="text-muted-foreground/70">MogulForge GrowthOS</span>
            </p>
            <nav aria-label="Legal" className="flex flex-wrap gap-4">
              {[
                { label: 'Privacy', href: '/privacy' },
                { label: 'Terms', href: '/terms' },
                { label: 'SMS Consent', href: '/sms-consent' },
                { label: 'Accessibility', href: '/accessibility' },
              ].map((l) => (
                <Link key={l.href} href={l.href} className="text-xs text-muted-foreground/60 hover:text-primary transition-colors">
                  {l.label}
                </Link>
              ))}
            </nav>
          </div>
        </div>
      </footer>
    </div>
  );
}
