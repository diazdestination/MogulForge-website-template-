import { useState } from 'react';
import { Link } from 'wouter';
import { Clock, Facebook, Loader2, MapPin, Phone, Send } from 'lucide-react';
import { useSubmitAssessment } from '@workspace/api-client-react';
import { Seo, breadcrumbJsonLd, localBusinessJsonLd } from '@/lib/seo';
import { Breadcrumbs, PageHero } from '@/components/page-blocks';
import { getVisitorContext, useAnalytics } from '@/lib/analytics';
import { useBusiness } from '@/lib/site-config';

export default function ContactPage() {
  const BUSINESS = useBusiness();
  const { track } = useAnalytics();
  const mutation = useSubmitAssessment();
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', phone: '', message: '', address: '', city: '', state: 'GA', postalCode: '' });
  const [smsOk, setSmsOk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!form.firstName.trim() || form.phone.trim().length < 7 || form.address.trim().length < 3 || !form.city.trim() || form.postalCode.trim().length < 3) {
      setError('Please provide your name, phone number, and property address so we can help.');
      return;
    }
    mutation.mutate(
      {
        data: {
          intent: 'general',
          urgency: 'normal',
          description: form.message || 'Contact form inquiry',
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim() || undefined,
          email: form.email.trim() || undefined,
          phone: form.phone.trim(),
          addressLine1: form.address.trim(),
          city: form.city.trim(),
          state: form.state.trim() || 'GA',
          postalCode: form.postalCode.trim(),
          source: 'contact-page',
          consent: {
            smsGranted: smsOk,
            emailGranted: Boolean(form.email.trim()),
            disclosureVersion: '2026-08-contact-page',
          },
          ...getVisitorContext(),
        },
      },
      {
        onSuccess: () => {
          setDone(true);
          track('conversion_completed', { label: 'contact_form' });
        },
        onError: () => setError('Something went wrong sending your message. Please try again or call us directly.'),
      },
    );
  };

  return (
    <div className="flex-1">
      <Seo
        title="Contact Us — 24/7 Roofing Help"
        description={`Contact Painless Roofing & Water Restoration in Canton, GA. Call ${BUSINESS.phone} any time — open 24 hours — or send a message online.`}
        path="/contact"
        jsonLd={[localBusinessJsonLd(BUSINESS), breadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: 'Contact', path: '/contact' }])]}
      />
      <div className="container mx-auto px-4 max-w-5xl pt-10">
        <Breadcrumbs items={[{ name: 'Home', href: '/' }, { name: 'Contact' }]} />
      </div>
      <PageHero
        eyebrow="Contact"
        title="Talk to a person, not a phone tree."
        lede="Call any time — we're open 24 hours, every day. Or send a message and we'll get back to you fast."
      />
      <section className="pb-20">
        <div className="container mx-auto px-4 max-w-5xl grid lg:grid-cols-5 gap-8">
          <div className="lg:col-span-2 space-y-4">
            <a
              href={BUSINESS.phoneHref}
              onClick={() => track('phone_clicked', { label: 'contact_page' })}
              className="flex items-center gap-4 p-6 rounded-2xl bg-primary/10 border border-primary/20 hover:bg-primary/15 transition-colors focus-visible:outline-2 focus-visible:outline-primary"
            >
              <Phone aria-hidden className="w-6 h-6 text-primary shrink-0" />
              <div>
                <div className="font-display font-bold text-white text-xl">{BUSINESS.phone}</div>
                <div className="text-sm text-muted-foreground">Fastest for emergencies</div>
              </div>
            </a>
            <div className="flex items-center gap-4 p-6 rounded-2xl bg-card/40 border border-card-border">
              <Clock aria-hidden className="w-6 h-6 text-primary shrink-0" />
              <div>
                <div className="font-medium text-white">{BUSINESS.hours}</div>
                <div className="text-sm text-muted-foreground">Storms don't keep business hours. Neither do we.</div>
              </div>
            </div>
            <div className="flex items-center gap-4 p-6 rounded-2xl bg-card/40 border border-card-border">
              <MapPin aria-hidden className="w-6 h-6 text-primary shrink-0" />
              <div>
                <div className="font-medium text-white">{BUSINESS.city}, {BUSINESS.state} {BUSINESS.postalCode}</div>
                <div className="text-sm text-muted-foreground">Serving North Georgia & metro Atlanta</div>
              </div>
            </div>
            <a
              href={BUSINESS.facebook}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-4 p-6 rounded-2xl bg-card/40 border border-card-border hover:border-primary/30 transition-colors focus-visible:outline-2 focus-visible:outline-primary"
            >
              <Facebook aria-hidden className="w-6 h-6 text-primary shrink-0" />
              <div className="font-medium text-white">Follow us on Facebook</div>
            </a>
          </div>

          <div className="lg:col-span-3">
            {done ? (
              <div className="p-10 rounded-3xl bg-card/60 border border-primary/30 text-center" role="status">
                <h2 className="text-2xl font-display font-bold text-white mb-3">Message received.</h2>
                <p className="text-muted-foreground mb-6">We'll reach out shortly. If this is urgent, call us now — a person answers 24/7.</p>
                <a href={BUSINESS.phoneHref} className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground font-semibold rounded-xl hover:bg-accent transition-colors">
                  <Phone aria-hidden className="w-4 h-4" /> {BUSINESS.phone}
                </a>
              </div>
            ) : (
              <form onSubmit={submit} noValidate className="p-8 rounded-3xl bg-card/50 border border-card-border space-y-5">
                {error && (
                  <div role="alert" className="p-4 rounded-xl bg-destructive/10 border border-destructive/30 text-red-300 text-sm">
                    {error}
                  </div>
                )}
                <div className="grid sm:grid-cols-2 gap-5">
                  <div>
                    <label htmlFor="firstName" className="block text-sm font-medium text-muted-foreground mb-2">First name *</label>
                    <input id="firstName" required autoComplete="given-name" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} className="w-full h-12 px-4 bg-background/50 border border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/50" />
                  </div>
                  <div>
                    <label htmlFor="lastName" className="block text-sm font-medium text-muted-foreground mb-2">Last name</label>
                    <input id="lastName" autoComplete="family-name" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} className="w-full h-12 px-4 bg-background/50 border border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/50" />
                  </div>
                  <div>
                    <label htmlFor="phone" className="block text-sm font-medium text-muted-foreground mb-2">Phone *</label>
                    <input id="phone" required type="tel" autoComplete="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="w-full h-12 px-4 bg-background/50 border border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/50" />
                  </div>
                  <div>
                    <label htmlFor="email" className="block text-sm font-medium text-muted-foreground mb-2">Email</label>
                    <input id="email" type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="w-full h-12 px-4 bg-background/50 border border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/50" />
                  </div>
                </div>
                <div className="grid sm:grid-cols-4 gap-5">
                  <div className="sm:col-span-2">
                    <label htmlFor="address" className="block text-sm font-medium text-muted-foreground mb-2">Property address *</label>
                    <input id="address" required autoComplete="street-address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className="w-full h-12 px-4 bg-background/50 border border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/50" />
                  </div>
                  <div>
                    <label htmlFor="city" className="block text-sm font-medium text-muted-foreground mb-2">City *</label>
                    <input id="city" required autoComplete="address-level2" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} className="w-full h-12 px-4 bg-background/50 border border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/50" />
                  </div>
                  <div>
                    <label htmlFor="postalCode" className="block text-sm font-medium text-muted-foreground mb-2">ZIP *</label>
                    <input id="postalCode" required autoComplete="postal-code" inputMode="numeric" value={form.postalCode} onChange={(e) => setForm({ ...form, postalCode: e.target.value })} className="w-full h-12 px-4 bg-background/50 border border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/50" />
                  </div>
                </div>
                <div>
                  <label htmlFor="message" className="block text-sm font-medium text-muted-foreground mb-2">How can we help?</label>
                  <textarea id="message" rows={5} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} className="w-full px-4 py-3 bg-background/50 border border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/50 resize-y" />
                </div>
                <label className="flex items-start gap-3 text-sm text-muted-foreground cursor-pointer">
                  <input type="checkbox" checked={smsOk} onChange={(e) => setSmsOk(e.target.checked)} className="mt-0.5 w-4 h-4 accent-[hsl(198,93%,60%)]" />
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
                  Send Message
                </button>
                <p className="text-xs text-muted-foreground/60">
                  By submitting, you agree to be contacted about your inquiry. See our{' '}
                  <Link href="/privacy" className="underline hover:text-primary">privacy policy</Link> and{' '}
                  <Link href="/sms-consent" className="underline hover:text-primary">SMS consent terms</Link>.
                </p>
              </form>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
