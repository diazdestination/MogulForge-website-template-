import { useState } from 'react';
import { Link } from 'wouter';
import {
  ArrowRight, BadgeCheck, Building2, CloudLightning, HardHat, Loader2, MapPin, Phone, Plane, Send, ShieldCheck, Wrench,
} from 'lucide-react';
import { useSubmitAssessment } from '@workspace/api-client-react';
import { SITE_ORIGIN } from '@/lib/business';
import { Seo, breadcrumbJsonLd, localBusinessJsonLd } from '@/lib/seo';
import { Breadcrumbs, CtaSection, FaqList, PageHero, SectionHeading } from '@/components/page-blocks';
import { useAnalytics } from '@/lib/analytics';
import { useBusiness } from '@/lib/site-config';

const NATIONWIDE_FAQS = [
  {
    question: 'How far will you travel for a job?',
    answer:
      'Anywhere in the Continental United States. We have traveled to handle large-loss events, commercial projects, and specialty installs from coast to coast. Distance is not the deciding factor — scope and fit are.',
  },
  {
    question: 'What kind of jobs make out-of-state travel worthwhile?',
    answer:
      "Large insurance losses, commercial re-roofing, storm-chaser situations where a property owner wants a trusted contractor instead of a local unknown, and vacation or investment properties where the owner has used us before and wants continuity. Single-shingle residential repair typically doesn't justify the travel cost — we'll tell you that upfront.",
  },
  {
    question: 'How does the inspection and documentation process work remotely?',
    answer:
      'We start with photos and available storm or satellite data to scope the job before anyone boards a plane. Once on site, we document everything — damage, deck condition, flashing, penetrations — with a full photo report. Out-of-area property owners get the same report their adjuster sees.',
  },
  {
    question: 'Can you work with my out-of-state insurance adjuster?',
    answer:
      'Yes. We document damage the way adjusters expect, and we can schedule a joint inspection wherever the property is located. We never guarantee claim outcomes — coverage decisions belong to your insurer — but we make sure legitimate damage is properly represented.',
  },
  {
    question: 'What is your licensing situation outside Georgia?',
    answer:
      'Contractor licensing requirements vary by state. We handle the appropriate licensing and permitting for each jurisdiction before any work begins. Ask us about your specific state and we\'ll give you a straight answer.',
  },
];

const PROJECT_TYPES = [
  { value: 'large-loss', label: 'Large-loss storm event', intent: 'storm' as const },
  { value: 'commercial', label: 'Commercial roofing', intent: 'replacement' as const },
  { value: 'vacation-property', label: 'Vacation or investment property', intent: 'general' as const },
  { value: 'storm-chaser-secondopinion', label: 'Storm-chaser second opinion', intent: 'storm' as const },
  { value: 'specialty-residential', label: 'Specialty residential', intent: 'replacement' as const },
  { value: 'insurance-claim', label: 'Insurance claim support', intent: 'storm' as const },
  { value: 'water-damage', label: 'Water damage / restoration', intent: 'water-damage' as const },
  { value: 'other', label: 'Other — describe below', intent: 'general' as const },
] as const;

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY',
  'LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND',
  'OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
];

const inputCls = 'w-full h-12 px-4 bg-background/50 border border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/50 text-white placeholder:text-muted-foreground/50';
const selectCls = 'w-full h-12 px-4 bg-background/50 border border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/50 text-white appearance-none';

export default function NationwidePage() {
  const BUSINESS = useBusiness();
  const { track } = useAnalytics();
  const mutation = useSubmitAssessment();

  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    phone: '',
    email: '',
    address: '',
    city: '',
    state: '',
    postalCode: '',
    projectType: '',
    description: '',
  });
  const [smsOk, setSmsOk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const patch = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!form.firstName.trim()) { setError('Please enter your first name.'); return; }
    if (form.phone.trim().length < 7) { setError('Please enter a valid phone number.'); return; }
    if (form.address.trim().length < 3 || !form.city.trim() || !form.state || form.postalCode.trim().length < 3) {
      setError('Please fill in the full property address (street, city, state, ZIP).'); return;
    }
    if (!form.projectType) { setError('Please select a project type.'); return; }

    const selected = PROJECT_TYPES.find((p) => p.value === form.projectType);
    const intentValue = selected?.intent ?? 'general';
    const descriptionParts = [`Project type: ${selected?.label ?? form.projectType}`];
    if (form.description.trim()) descriptionParts.push(form.description.trim());
    const fullDescription = descriptionParts.join('\n\n');

    mutation.mutate(
      {
        data: {
          intent: intentValue,
          urgency: 'normal',
          description: fullDescription,
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim() || undefined,
          email: form.email.trim() || undefined,
          phone: form.phone.trim(),
          addressLine1: form.address.trim(),
          city: form.city.trim(),
          state: form.state,
          postalCode: form.postalCode.trim(),
          source: 'nationwide-inquiry',
          consent: {
            smsGranted: smsOk,
            emailGranted: Boolean(form.email.trim()),
            disclosureVersion: '2026-08-nationwide-page',
          },
        },
      },
      {
        onSuccess: () => {
          setDone(true);
          track('conversion_completed', { label: 'nationwide_travel_quote' });
        },
        onError: () => setError('Something went wrong sending your request. Please try again or call us directly.'),
      },
    );
  };

  return (
    <div className="flex-1">
      <Seo
        title="Nationwide Roofing & Restoration — Continental US Travel"
        description="Painless Roofing & Water Restoration travels anywhere in the Continental US for large-loss, commercial, and out-of-state roofing and water damage restoration. Call (404) 444-4476."
        path="/nationwide"
        ogImage={`${SITE_ORIGIN}/og-nationwide.png`}
        jsonLd={[
          localBusinessJsonLd(BUSINESS),
          breadcrumbJsonLd([
            { name: 'Home', path: '/' },
            { name: 'Nationwide Coverage', path: '/nationwide' },
          ]),
        ]}
      />

      <div className="container mx-auto px-4 max-w-4xl pt-10">
        <Breadcrumbs items={[{ name: 'Home', href: '/' }, { name: 'Nationwide Coverage' }]} />
      </div>

      <PageHero
        eyebrow="Continental US Coverage"
        title={
          <>
            Your roof doesn't know<br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-white via-primary to-accent">
              what state it's in.
            </span>
          </>
        }
        lede="Based in Canton, GA — but licensed and ready to travel anywhere in the Continental United States for roofing and water damage restoration work. Large loss, commercial, storm events, or out-of-state property you need handled right: we make the trip."
      >
        <div className="flex flex-col sm:flex-row gap-4 mt-8">
          <a
            href="#travel-quote"
            className="w-full sm:w-auto px-8 py-4 bg-primary text-primary-foreground font-semibold rounded-xl hover:bg-accent transition-colors flex items-center justify-center gap-2 shadow-[0_0_30px_rgba(56,189,248,0.3)] text-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            Request a Travel Quote <ArrowRight aria-hidden className="w-5 h-5" />
          </a>
          <a
            href={BUSINESS.phoneHref}
            className="w-full sm:w-auto px-8 py-4 bg-white/5 text-white font-semibold rounded-xl border border-white/10 hover:bg-white/10 transition-colors flex items-center justify-center gap-2 text-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <Phone aria-hidden className="w-5 h-5 text-primary" /> {BUSINESS.phone}
          </a>
        </div>
      </PageHero>

      {/* What we travel for */}
      <section className="py-20 border-t border-white/5 bg-card/10">
        <div className="container mx-auto px-4 max-w-5xl">
          <SectionHeading sub="Not every job justifies the trip. These do.">What we travel for</SectionHeading>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {[
              {
                icon: CloudLightning,
                title: 'Large-loss storm events',
                body: 'Major hail, tornado, or wind events that hit an area you own property in — we mobilize a crew, document the damage, and manage the restoration start to finish.',
              },
              {
                icon: Building2,
                title: 'Commercial roofing',
                body: 'Flat or low-slope commercial re-roofing, TPO, EPDM, standing seam — scope, bid, and execute anywhere in the Continental US.',
              },
              {
                icon: Plane,
                title: 'Out-of-state property owners',
                body: "You're three states away when something goes wrong. We handle the inspection, documentation, and repair — and you get a complete photo report, not a phone call telling you to trust them.",
              },
              {
                icon: ShieldCheck,
                title: 'Storm-chaser situations',
                body: "If a fly-by-night crew knocked on your door after a storm, you probably want a second opinion from a contractor who isn't leaving town next week.",
              },
              {
                icon: Wrench,
                title: 'Specialty residential',
                body: 'High-end custom homes, unique materials, or jobs where the owner wants their established contractor instead of an unfamiliar local crew.',
              },
              {
                icon: HardHat,
                title: 'Insurance claim support',
                body: 'We document damage the way adjusters expect, meet your adjuster on site, and prepare the supplement documentation your claim needs — wherever the property is.',
              },
            ].map((item) => (
              <div key={item.title} className="p-7 rounded-3xl bg-card/40 border border-card-border">
                <item.icon aria-hidden className="w-7 h-7 text-primary mb-4" />
                <h3 className="font-display font-semibold text-white text-lg mb-2">{item.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Why us */}
      <section className="py-20 border-t border-white/5">
        <div className="container mx-auto px-4 max-w-4xl">
          <SectionHeading sub="What you get when you bring us in from out of state.">The same crew, the same standard</SectionHeading>
          <div className="space-y-6 text-lg text-muted-foreground leading-relaxed mb-12">
            <p>
              Storm events and large losses tend to attract contractors who are optimized for volume, not quality. When a
              hail cell hits a region, dozens of crews descend and move fast — because the business window closes as
              insurance money runs out. That's not how we operate whether we're two miles from base or two thousand.
            </p>
            <p>
              We bring the same crew discipline, photo documentation, and material standards we use in North Georgia.
              Damage is documented the way adjusters expect before anything is touched. Scope is written before work
              begins. You get a complete report — not a post-job invoice you can't decipher.
            </p>
            <p>
              We're family-owned. There's no regional manager between you and the owner of the company. If something goes
              wrong on your job — wherever it is — you talk to us directly.
            </p>
          </div>
          <div className="grid sm:grid-cols-3 gap-4">
            {[
              { icon: BadgeCheck, label: 'Licensed & insured', sub: 'Proper licensing handled for each jurisdiction' },
              { icon: MapPin, label: 'Continental US', sub: 'Any state, any climate, any roof type' },
              { icon: Phone, label: 'Open 24 hours', sub: 'Real person answers, any day of the week' },
            ].map((trust) => (
              <div key={trust.label} className="flex flex-col items-center text-center p-6 rounded-2xl bg-card/30 border border-card-border">
                <trust.icon aria-hidden className="w-8 h-8 text-primary mb-3" />
                <p className="font-semibold text-white text-sm mb-1">{trust.label}</p>
                <p className="text-xs text-muted-foreground">{trust.sub}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Travel Quote Form */}
      <section id="travel-quote" className="py-20 border-t border-white/5 bg-card/10">
        <div className="container mx-auto px-4 max-w-3xl">
          <SectionHeading sub="Tell us where it is, what happened, and how to reach you. We'll get back to you within 24 hours with a straight answer on whether it's a fit.">
            Request a travel quote
          </SectionHeading>

          {done ? (
            <div className="p-10 rounded-3xl bg-card/60 border border-primary/30 text-center" role="status">
              <h2 className="text-2xl font-display font-bold text-white mb-3">Request received.</h2>
              <p className="text-muted-foreground mb-6">
                We'll review your project and reach out within 24 hours. If this is urgent, call us now — a person answers 24/7.
              </p>
              <a
                href={BUSINESS.phoneHref}
                className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground font-semibold rounded-xl hover:bg-accent transition-colors"
              >
                <Phone aria-hidden className="w-4 h-4" /> {BUSINESS.phone}
              </a>
            </div>
          ) : (
            <form onSubmit={submit} noValidate className="p-8 rounded-3xl bg-card/50 border border-card-border space-y-6">
              {error && (
                <div role="alert" className="p-4 rounded-xl bg-destructive/10 border border-destructive/30 text-red-300 text-sm">
                  {error}
                </div>
              )}

              {/* Contact info */}
              <fieldset className="space-y-4">
                <legend className="text-sm font-semibold text-white/70 uppercase tracking-wider mb-4">Your contact info</legend>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="nw-firstName" className="block text-sm font-medium text-muted-foreground mb-2">First name *</label>
                    <input id="nw-firstName" required autoComplete="given-name" value={form.firstName} onChange={patch('firstName')} className={inputCls} />
                  </div>
                  <div>
                    <label htmlFor="nw-lastName" className="block text-sm font-medium text-muted-foreground mb-2">Last name</label>
                    <input id="nw-lastName" autoComplete="family-name" value={form.lastName} onChange={patch('lastName')} className={inputCls} />
                  </div>
                  <div>
                    <label htmlFor="nw-phone" className="block text-sm font-medium text-muted-foreground mb-2">Phone *</label>
                    <input id="nw-phone" required type="tel" autoComplete="tel" value={form.phone} onChange={patch('phone')} className={inputCls} />
                  </div>
                  <div>
                    <label htmlFor="nw-email" className="block text-sm font-medium text-muted-foreground mb-2">Email</label>
                    <input id="nw-email" type="email" autoComplete="email" value={form.email} onChange={patch('email')} className={inputCls} />
                  </div>
                </div>
              </fieldset>

              {/* Property address */}
              <fieldset className="space-y-4">
                <legend className="text-sm font-semibold text-white/70 uppercase tracking-wider mb-4">Property address</legend>
                <div>
                  <label htmlFor="nw-address" className="block text-sm font-medium text-muted-foreground mb-2">Street address *</label>
                  <input id="nw-address" required autoComplete="street-address" value={form.address} onChange={patch('address')} className={inputCls} />
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div className="col-span-2">
                    <label htmlFor="nw-city" className="block text-sm font-medium text-muted-foreground mb-2">City *</label>
                    <input id="nw-city" required autoComplete="address-level2" value={form.city} onChange={patch('city')} className={inputCls} />
                  </div>
                  <div>
                    <label htmlFor="nw-state" className="block text-sm font-medium text-muted-foreground mb-2">State *</label>
                    <select id="nw-state" required autoComplete="address-level1" value={form.state} onChange={patch('state')} className={selectCls}>
                      <option value="">—</option>
                      {US_STATES.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="nw-postalCode" className="block text-sm font-medium text-muted-foreground mb-2">ZIP *</label>
                    <input id="nw-postalCode" required autoComplete="postal-code" inputMode="numeric" value={form.postalCode} onChange={patch('postalCode')} className={inputCls} />
                  </div>
                </div>
              </fieldset>

              {/* Project type */}
              <fieldset className="space-y-3">
                <legend className="text-sm font-semibold text-white/70 uppercase tracking-wider mb-4">Project type *</legend>
                <div className="grid sm:grid-cols-2 gap-3">
                  {PROJECT_TYPES.map((pt) => (
                    <label
                      key={pt.value}
                      className={`flex items-center gap-3 p-4 rounded-xl border cursor-pointer transition-colors ${
                        form.projectType === pt.value
                          ? 'border-primary/60 bg-primary/10 text-white'
                          : 'border-white/10 bg-background/30 text-muted-foreground hover:border-white/20'
                      }`}
                    >
                      <input
                        type="radio"
                        name="projectType"
                        value={pt.value}
                        checked={form.projectType === pt.value}
                        onChange={patch('projectType')}
                        className="accent-[hsl(198,93%,60%)] w-4 h-4 shrink-0"
                      />
                      <span className="text-sm font-medium">{pt.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              {/* Description */}
              <div>
                <label htmlFor="nw-description" className="block text-sm font-medium text-muted-foreground mb-2">
                  Describe the project <span className="text-muted-foreground/50">(roof size, damage extent, timeline, anything helpful)</span>
                </label>
                <textarea
                  id="nw-description"
                  rows={5}
                  value={form.description}
                  onChange={patch('description')}
                  placeholder="e.g. 15-square commercial flat roof, hail damage from last week's storm, adjuster scheduled for Thursday…"
                  className="w-full px-4 py-3 bg-background/50 border border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/50 resize-y text-white placeholder:text-muted-foreground/40"
                />
              </div>

              {/* SMS consent */}
              <label className="flex items-start gap-3 text-sm text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={smsOk}
                  onChange={(e) => setSmsOk(e.target.checked)}
                  className="mt-0.5 w-4 h-4 accent-[hsl(198,93%,60%)]"
                />
                <span>
                  It's OK to text me about my inquiry. Message and data rates may apply; reply STOP to opt out. See{' '}
                  <Link href="/sms-consent" className="underline hover:text-primary">SMS consent terms</Link>.
                </span>
              </label>

              <button
                type="submit"
                disabled={mutation.isPending}
                className="w-full h-14 bg-primary text-primary-foreground font-semibold rounded-xl hover:bg-accent transition-colors flex items-center justify-center gap-2 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                {mutation.isPending ? <Loader2 aria-hidden className="w-5 h-5 animate-spin" /> : <Send aria-hidden className="w-5 h-5" />}
                Send Travel Quote Request
              </button>

              <p className="text-xs text-muted-foreground/60">
                By submitting, you agree to be contacted about your inquiry. See our{' '}
                <Link href="/privacy" className="underline hover:text-primary">privacy policy</Link> and{' '}
                <Link href="/sms-consent" className="underline hover:text-primary">SMS consent terms</Link>.
              </p>
            </form>
          )}
        </div>
      </section>

      {/* North Georgia home base note */}
      <section className="py-16 border-t border-white/5 bg-card/10">
        <div className="container mx-auto px-4 max-w-4xl">
          <div className="p-8 rounded-3xl bg-primary/5 border border-primary/15">
            <h2 className="text-xl font-display font-semibold text-white mb-3">Based in North Georgia — expert in the Southeast</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              Our home market is Canton, GA and the surrounding North Georgia communities — Cherokee, Forsyth, Hall, and
              Cobb counties. If your property is in or near the Atlanta metro, we're not traveling at all. We serve North
              Georgia every day.
            </p>
            <Link href="/service-areas" className="inline-flex items-center gap-2 text-primary font-medium hover:underline focus-visible:outline-2 focus-visible:outline-primary rounded">
              See our North Georgia service areas <ArrowRight aria-hidden className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="py-20 border-t border-white/5">
        <div className="container mx-auto px-4 max-w-4xl">
          <SectionHeading>Common questions about out-of-state work</SectionHeading>
          <FaqList faqs={NATIONWIDE_FAQS} />
        </div>
      </section>

      <CtaSection
        heading="Tell us where and what — we'll give you a straight answer."
        sub="Large loss, commercial project, out-of-state property: call or contact us and we'll tell you within 24 hours whether it's a fit."
        primaryLabel="Request a Travel Quote"
        primaryHref="#travel-quote"
        trackLabel="nationwide"
      />
    </div>
  );
}
