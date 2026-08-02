import React from 'react';
import { Link } from 'wouter';
import { Seo, breadcrumbJsonLd } from '@/lib/seo';
import { Breadcrumbs, PageHero } from '@/components/page-blocks';
import { useBusiness } from '@/lib/site-config';

function LegalShell({ title, description, path, children }: { title: string; description: string; path: string; children: React.ReactNode }) {
  return (
    <div className="flex-1">
      <Seo title={title} description={description} path={path} jsonLd={breadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: title, path }])} />
      <div className="container mx-auto px-4 max-w-3xl pt-10">
        <Breadcrumbs items={[{ name: 'Home', href: '/' }, { name: title }]} />
      </div>
      <PageHero title={title} />
      <section className="pb-20">
        <div className="container mx-auto px-4 max-w-3xl prose prose-invert prose-p:text-muted-foreground prose-li:text-muted-foreground prose-headings:font-display">
          {children}
        </div>
      </section>
    </div>
  );
}

export function PrivacyPage() {
  const BUSINESS = useBusiness();
  return (
    <LegalShell title="Privacy Policy" description={`How ${BUSINESS.name} collects, uses, and protects your information.`} path="/privacy">
      <p><em>Last updated: August 2026</em></p>
      <h2>Information we collect</h2>
      <p>
        When you use our website, request an assessment, or contact us, we may collect your name, phone number, email
        address, property address, photos you upload, and details you provide about your roofing or water damage
        situation. We also collect standard analytics data such as pages visited, referring site, and campaign
        parameters, tied to an anonymous identifier.
      </p>
      <h2>How we use it</h2>
      <ul>
        <li>To respond to your inquiry, schedule inspections, and provide services you request</li>
        <li>To follow up on assessments, estimates, and active projects</li>
        <li>To understand how our website is used so we can improve it</li>
      </ul>
      <h2>What we don't do</h2>
      <p>We do not sell your personal information. We share it only with service providers who help us operate (for example, communication providers) and as required by law.</p>
      <h2>Text messaging</h2>
      <p>SMS communication is governed by our <Link href="/sms-consent">SMS consent terms</Link>. You can opt out of texts at any time by replying STOP.</p>
      <h2>Your choices</h2>
      <p>You may request access to, correction of, or deletion of your personal information by contacting us at {BUSINESS.phone}.</p>
      <h2>Contact</h2>
      <p>{BUSINESS.name}, {BUSINESS.city}, {BUSINESS.state} {BUSINESS.postalCode} — {BUSINESS.phone}.</p>
    </LegalShell>
  );
}

export function TermsPage() {
  const BUSINESS = useBusiness();
  return (
    <LegalShell title="Terms of Service" description={`Terms governing use of the ${BUSINESS.name} website and online tools.`} path="/terms">
      <p><em>Last updated: August 2026</em></p>
      <h2>Use of this website</h2>
      <p>
        This website provides information about our services and online tools such as the roof assessment and storm
        address checker. Using these tools does not create a contract for services; work begins only under a signed
        agreement.
      </p>
      <h2>Online guidance is not an inspection</h2>
      <p>
        Information provided through this website — including assessment guidance and storm activity data — is
        informational only. It is not a professional inspection, does not confirm or rule out roof damage, and does not
        constitute a guarantee of insurance coverage, claim approval, pricing, or structural safety. A physical
        inspection by a qualified professional is required before any conclusion about your roof's condition.
      </p>
      <h2>Storm data</h2>
      <p>
        Storm activity results are based on available weather data and are presented as approximations. They must not be
        relied upon as proof that a specific property was damaged.
      </p>
      <h2>Limitation of liability</h2>
      <p>
        To the fullest extent permitted by law, {BUSINESS.name} is not liable for decisions made solely on the basis of
        information from this website.
      </p>
      <h2>Contact</h2>
      <p>Questions about these terms: {BUSINESS.phone}.</p>
    </LegalShell>
  );
}

export function SmsConsentPage() {
  const BUSINESS = useBusiness();
  return (
    <LegalShell title="SMS Consent" description={`Text messaging terms for ${BUSINESS.name} — what you're agreeing to and how to opt out.`} path="/sms-consent">
      <h2>What you're agreeing to</h2>
      <p>
        By providing your phone number and opting in to text messages, you consent to receive SMS messages from{' '}
        {BUSINESS.name} about your inquiry, assessment, appointments, estimates, and active projects. Message frequency
        varies with your project activity.
      </p>
      <h2>Costs</h2>
      <p>Message and data rates may apply according to your mobile carrier plan. We never charge for text messages.</p>
      <h2>Opting out</h2>
      <p>
        Reply <strong>STOP</strong> to any message to opt out at any time. Reply <strong>HELP</strong> for assistance, or
        call us at {BUSINESS.phone}. Opting out of texts does not affect the services we provide — we'll simply use your
        preferred contact method instead.
      </p>
      <h2>Privacy</h2>
      <p>Your phone number is handled according to our <Link href="/privacy">privacy policy</Link>. We do not sell your number or share it for third-party marketing.</p>
    </LegalShell>
  );
}

export function AccessibilityPage() {
  const BUSINESS = useBusiness();
  return (
    <LegalShell title="Accessibility" description={`${BUSINESS.name}'s commitment to an accessible website for all visitors.`} path="/accessibility">
      <h2>Our commitment</h2>
      <p>
        We want every homeowner to be able to use this website — including visitors using screen readers, keyboard
        navigation, or reduced-motion settings. We build toward the Web Content Accessibility Guidelines (WCAG) 2.1
        Level AA.
      </p>
      <h2>What we've implemented</h2>
      <ul>
        <li>Full keyboard navigation with visible focus indicators</li>
        <li>Semantic HTML with proper headings, labels, and landmarks</li>
        <li>Reduced-motion support that respects your system preference</li>
        <li>Color contrast designed to meet AA standards</li>
        <li>Form error messages announced to assistive technology</li>
      </ul>
      <h2>Found a barrier?</h2>
      <p>
        If any part of this site is difficult to use with assistive technology, please tell us. Call {BUSINESS.phone} —
        we're available 24/7 — and we'll both help you directly and fix the underlying issue.
      </p>
    </LegalShell>
  );
}
