import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Redirect, Route, Switch, Router as WouterRouter } from 'wouter';

import { Layout } from '@/components/layout';
import HomePage from '@/pages/home';
import StormCheckPage from '@/pages/storm-check';
import AssessmentPage from '@/pages/assessment';
import ServicePage, { ServicesIndexPage } from '@/pages/service';
import AreaPage, { AreasIndexPage } from '@/pages/area';
import ContactPage from '@/pages/contact';
import { AboutPage, FinancingPage, GalleryPage, ResourcesPage, ReviewsPage } from '@/pages/company';
import { AccessibilityPage, PrivacyPage, SmsConsentPage, TermsPage } from '@/pages/legal';
import { AnalyticsProvider } from '@/lib/analytics';
import { SiteConfigProvider } from '@/lib/site-config';
import type { PublicSiteConfig } from '@workspace/api-client-react';
import ConciergePage from '@/pages/concierge';
import PortalPage from '@/pages/portal';
import NationwidePage from '@/pages/nationwide';

const queryClient = new QueryClient();

/** Old-site URL → new destination (SPA-level redirects). */
export const LEGACY_REDIRECTS: Array<{ from: string; to: string }> = [
  { from: '/services/roof-repair-replacement', to: '/services/roof-repair' },
  { from: '/services/water-damage-restoration', to: '/services/water-damage-restoration' },
  { from: '/services/storm-damage-insurance-claim-assistance', to: '/services/storm-damage' },
  { from: '/services/metal-roof-installation-repair', to: '/services/metal-roofing' },
  { from: '/services/gutter-services', to: '/services/gutters' },
];

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={HomePage} />
        <Route path="/storm-check" component={StormCheckPage} />
        <Route path="/assessment" component={AssessmentPage} />
        <Route path="/concierge" component={ConciergePage} />
        <Route path="/portal" component={PortalPage} />
        {LEGACY_REDIRECTS.filter((r) => r.from !== r.to).map((r) => (
          <Route key={r.from} path={r.from}>
            <Redirect to={r.to} replace />
          </Route>
        ))}
        <Route path="/services" component={ServicesIndexPage} />
        <Route path="/services/:slug" component={ServicePage} />
        <Route path="/service-areas" component={AreasIndexPage} />
        <Route path="/service-areas/:slug" component={AreaPage} />
        <Route path="/about" component={AboutPage} />
        <Route path="/gallery" component={GalleryPage} />
        <Route path="/reviews" component={ReviewsPage} />
        <Route path="/financing" component={FinancingPage} />
        <Route path="/resources" component={ResourcesPage} />
        <Route path="/nationwide" component={NationwidePage} />
        <Route path="/contact" component={ContactPage} />
        <Route path="/privacy" component={PrivacyPage} />
        <Route path="/terms" component={TermsPage} />
        <Route path="/sms-consent" component={SmsConsentPage} />
        <Route path="/accessibility" component={AccessibilityPage} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App({ ssrPath, ssrSiteConfig }: { ssrPath?: string; ssrSiteConfig?: PublicSiteConfig }) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')} ssrPath={ssrPath}>
          <SiteConfigProvider ssrData={ssrSiteConfig}>
            <AnalyticsProvider>
              <Router />
            </AnalyticsProvider>
          </SiteConfigProvider>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
