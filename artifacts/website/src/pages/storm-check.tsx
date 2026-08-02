import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useAnalytics } from '@/lib/analytics';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, MapPin, AlertTriangle, ShieldCheck, ArrowRight, CloudLightning, FlaskConical, Wind } from 'lucide-react';
import { useCheckStormActivity } from '@workspace/api-client-react';
import { Seo, breadcrumbJsonLd } from '@/lib/seo';
import { SITE_ORIGIN } from '@/lib/business';

interface StormEventView {
  type: string;
  severity: string;
  magnitude: string;
  distanceMiles: number;
  date: string;
}

export default function StormCheckPage() {
  const [, setLocation] = useLocation();
  const { track } = useAnalytics();
  const mutation = useCheckStormActivity();

  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);

  const result = mutation.data;

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (address.trim().length < 5) {
      setError('Please enter your full street address so we can check nearby storm activity.');
      return;
    }
    track('address_checked', { addressLength: address.trim().length });
    mutation.mutate(
      { data: { address: address.trim() } },
      { onError: () => setError('We could not run the storm check right now. Please try again, or start an assessment instead.') },
    );
  };

  const handleContinue = () => {
    sessionStorage.setItem('painless_storm_address', address);
    setLocation('/assessment?intent=storm');
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center py-20 px-4 min-h-[calc(100vh-64px)] relative overflow-hidden">
      <Seo
        title="Storm Address Checker — Recent Hail & Wind Activity"
        description="Check your Georgia address against recent storm activity reports. Free, instant, and informational — a starting point before a professional roof inspection."
        path="/storm-check"
        ogImage={`${SITE_ORIGIN}/og-storm-check.png`}
        jsonLd={breadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: 'Storm Address Checker', path: '/storm-check' }])}
      />
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[800px] h-[800px] bg-primary/5 rounded-full blur-[100px] pointer-events-none motion-reduce:hidden" aria-hidden />

      <div className="w-full max-w-2xl relative z-10">
        <div className="text-center mb-12">
          <motion.h1
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}
            className="text-4xl md:text-6xl font-display font-bold mb-6 motion-reduce:transition-none"
          >
            Storm Activity Check
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.1 }}
            className="text-xl text-muted-foreground motion-reduce:transition-none"
          >
            Check your property against recent severe weather reports.
          </motion.p>
        </div>

        <AnimatePresence mode="wait">
          {!result && !mutation.isPending && (
            <motion.div
              key="idle"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.4 }}
            >
              <form onSubmit={handleSearch} noValidate className="bg-card/80 backdrop-blur-xl p-8 md:p-10 rounded-3xl border border-card-border shadow-2xl relative overflow-hidden">
                <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-primary via-accent to-primary" aria-hidden />
                <label htmlFor="storm-address" className="block text-base text-muted-foreground font-medium mb-3">Property Address</label>
                {error && (
                  <p role="alert" className="mb-4 p-3 rounded-xl bg-destructive/10 border border-destructive/30 text-red-300 text-sm">{error}</p>
                )}
                <div className="flex flex-col sm:flex-row gap-4">
                  <div className="relative flex-1">
                    <MapPin aria-hidden className="absolute left-4 top-1/2 -translate-y-1/2 w-6 h-6 text-muted-foreground/60" />
                    <input
                      id="storm-address"
                      required
                      placeholder="Enter your street address..."
                      className="w-full pl-14 pr-4 h-16 bg-background/50 border border-white/10 rounded-xl text-lg focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all placeholder:text-muted-foreground/40"
                      value={address}
                      onChange={e => setAddress(e.target.value)}
                    />
                  </div>
                  <button
                    type="submit"
                    className="h-16 px-8 bg-primary text-primary-foreground font-semibold rounded-xl hover:bg-accent transition-colors flex items-center justify-center gap-2 text-lg shrink-0 shadow-lg shadow-primary/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  >
                    <Search aria-hidden className="w-5 h-5" />
                    Check Area
                  </button>
                </div>
                <p className="mt-5 text-xs text-muted-foreground/60">
                  Informational only — storm activity near your address is not proof of roof damage. Only a professional
                  inspection can confirm your roof's condition.
                </p>
              </form>
            </motion.div>
          )}

          {mutation.isPending && (
            <motion.div
              key="searching"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.4 }}
              role="status"
              className="flex flex-col items-center justify-center py-20 bg-card/40 rounded-3xl border border-card-border backdrop-blur-xl"
            >
              <div className="w-20 h-20 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center mb-8 relative">
                <div className="absolute inset-0 rounded-full border-2 border-primary/30 border-t-primary animate-spin motion-reduce:animate-none" aria-hidden />
                <CloudLightning aria-hidden className="w-8 h-8 text-primary animate-pulse motion-reduce:animate-none" />
              </div>
              <h2 className="text-2xl font-display font-medium mb-3 text-white">Checking Weather Records</h2>
              <p className="text-muted-foreground text-lg">Looking up recent hail and wind reports near you...</p>
            </motion.div>
          )}

          {result && (
            <motion.div
              key="results"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
              className="space-y-6"
            >
              {result.isDemoData && (
                <p className="flex items-center gap-2 justify-center text-sm text-amber-300/90 bg-amber-400/10 border border-amber-400/20 rounded-full px-5 py-2.5 w-fit mx-auto">
                  <FlaskConical aria-hidden className="w-4 h-4" />
                  Demonstration data — live weather feeds are not yet connected.
                </p>
              )}
              <div className="bg-card/80 backdrop-blur-xl p-8 rounded-3xl border border-card-border shadow-2xl">
                <div className="flex items-start gap-5 mb-8">
                  <div className="w-14 h-14 rounded-2xl bg-orange-500/10 border border-orange-500/20 flex items-center justify-center shrink-0" aria-hidden>
                    <AlertTriangle className="w-7 h-7 text-orange-400" />
                  </div>
                  <div className="pt-1">
                    <h2 className="text-2xl font-display font-semibold mb-2 text-white">Recent storm activity near this address</h2>
                    <p className="text-muted-foreground text-base leading-relaxed">
                      Weather records show storm events near <strong className="text-white font-medium">{result.address}</strong>.
                    </p>
                  </div>
                </div>

                <ul className="space-y-4 mb-8">
                  {(result.events as StormEventView[]).map((event, i) => (
                    <li key={i} className="p-5 rounded-2xl bg-background/50 border border-white/5 flex items-center gap-4">
                      {event.type === 'hail'
                        ? <CloudLightning aria-hidden className="w-6 h-6 text-primary shrink-0" />
                        : <Wind aria-hidden className="w-6 h-6 text-primary shrink-0" />}
                      <div className="flex-1">
                        <div className="font-semibold text-white capitalize">{event.type} event — {event.magnitude}</div>
                        <div className="text-sm text-muted-foreground">
                          ~{event.distanceMiles.toFixed(1)} miles away · {event.date} · severity: <span className="capitalize">{event.severity}</span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>

                <div className="p-6 rounded-2xl bg-primary/10 border border-primary/20 flex items-start gap-4">
                  <ShieldCheck aria-hidden className="w-6 h-6 text-primary shrink-0 mt-0.5" />
                  <p className="text-base text-primary-foreground/90 leading-relaxed">
                    <strong className="text-primary block mb-1">
                      {result.suggestedNextAction === 'schedule_inspection' ? 'Recommendation: schedule an inspection' : 'Recommendation: monitor your roof'}
                    </strong>
                    {result.suggestedNextAction === 'schedule_inspection'
                      ? 'Storms of this severity can cause roof damage that is invisible from the ground. A free assessment will help determine whether a professional inspection is warranted.'
                      : 'Nearby activity was minor. Keep an eye on your ceilings after heavy rain, and get an inspection if anything changes.'}
                  </p>
                </div>
              </div>

              <button
                onClick={handleContinue}
                className="w-full h-16 bg-primary text-primary-foreground font-semibold rounded-2xl hover:bg-accent transition-colors flex items-center justify-center gap-3 text-xl group shadow-[0_0_30px_rgba(56,189,248,0.2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                Start Roof Assessment
                <ArrowRight aria-hidden className="w-6 h-6 group-hover:translate-x-1 transition-transform motion-reduce:transition-none" />
              </button>

              <p className="text-xs text-center text-muted-foreground/60 max-w-md mx-auto">
                Storm activity data is informational and does not prove that this specific roof is damaged. It does not
                replace a physical inspection. See our <Link href="/terms" className="underline hover:text-primary">terms</Link>.
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
