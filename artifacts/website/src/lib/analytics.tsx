import React, { useCallback, useEffect } from 'react';
import { useLocation } from 'wouter';
import { useTrackAnalyticsEvent } from '@workspace/api-client-react';

function getOrSetId(key: string, storage: Storage) {
  try {
    let id = storage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      storage.setItem(key, id);
    }
    return id;
  } catch (e) {
    return 'unknown';
  }
}

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;

interface TouchAttribution {
  utm: Partial<Record<(typeof UTM_KEYS)[number], string>>;
  landingPage: string;
  referrer: string;
  at: string;
}

function readStored(key: string): TouchAttribution | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as TouchAttribution) : null;
  } catch {
    return null;
  }
}

/**
 * Capture UTM/referrer attribution once per page load:
 * - first touch is stored permanently (localStorage) and never overwritten
 * - last touch updates whenever a new campaign/referrer arrives
 */
function captureAttribution() {
  try {
    const params = new URLSearchParams(window.location.search);
    const utm: TouchAttribution['utm'] = {};
    let hasUtm = false;
    for (const key of UTM_KEYS) {
      const value = params.get(key);
      if (value) {
        utm[key] = value;
        hasUtm = true;
      }
    }
    const touch: TouchAttribution = {
      utm,
      landingPage: window.location.pathname,
      referrer: document.referrer,
      at: new Date().toISOString(),
    };
    if (!readStored('painless_first_touch')) {
      localStorage.setItem('painless_first_touch', JSON.stringify(touch));
    }
    // Update last touch when a campaign or external referrer is present.
    const externalReferrer = document.referrer && !document.referrer.includes(window.location.hostname);
    if (hasUtm || externalReferrer || !readStored('painless_last_touch')) {
      localStorage.setItem('painless_last_touch', JSON.stringify(touch));
    }
  } catch {
    // Attribution is best-effort.
  }
}

function attributionProperties(): Record<string, unknown> {
  const first = readStored('painless_first_touch');
  const last = readStored('painless_last_touch');
  const props: Record<string, unknown> = {};
  if (first) props.firstTouch = first;
  if (last) props.lastTouch = last;
  return props;
}

/**
 * Visitor identifiers + first-touch attribution for lead submissions.
 * Passing these along when the visitor identifies themselves lets the CRM
 * link prior session behavior to the lead (consent by identification).
 */
export function getVisitorContext(): {
  anonymousId?: string;
  sessionId?: string;
  attribution?: {
    landingPage?: string;
    referrer?: string;
    utmSource?: string;
    utmMedium?: string;
    utmCampaign?: string;
    utmTerm?: string;
    utmContent?: string;
  };
} {
  try {
    const first = readStored('painless_first_touch');
    const attribution = first
      ? {
          landingPage: first.landingPage || undefined,
          referrer: first.referrer || undefined,
          utmSource: first.utm.utm_source,
          utmMedium: first.utm.utm_medium,
          utmCampaign: first.utm.utm_campaign,
          utmTerm: first.utm.utm_term,
          utmContent: first.utm.utm_content,
        }
      : undefined;
    const anonymousId = getOrSetId('painless_anon_id', localStorage);
    const sessionId = getOrSetId('painless_session_id', sessionStorage);
    return {
      anonymousId: anonymousId !== 'unknown' ? anonymousId : undefined,
      sessionId: sessionId !== 'unknown' ? sessionId : undefined,
      attribution,
    };
  } catch {
    return {};
  }
}

export function useAnalytics() {
  const mutation = useTrackAnalyticsEvent();

  const track = useCallback((eventName: string, properties?: Record<string, unknown>) => {
    try {
      const anonymousId = getOrSetId('painless_anon_id', localStorage);
      const sessionId = getOrSetId('painless_session_id', sessionStorage);

      mutation.mutate({
        data: {
          eventName,
          anonymousId,
          sessionId,
          path: window.location.pathname,
          referrer: document.referrer,
          properties: { ...attributionProperties(), ...properties },
        }
      }, {
        onError: () => {} // swallow errors
      });
    } catch (e) {
      // Fire and forget, swallow errors
    }
  }, [mutation.mutate]);

  return { track };
}

export function AnalyticsProvider({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { track } = useAnalytics();

  useEffect(() => {
    captureAttribution();
    // Disable the browser's built-in scroll restoration so our own scrollTo(0,0)
    // on navigation is not immediately overridden by the History API restoring the
    // previous position.
    if ('scrollRestoration' in history) {
      history.scrollRestoration = 'manual';
    }
  }, []);

  // Scroll to top on every SPA navigation — separate from the analytics effect so
  // it is only keyed on location, not on the track callback identity.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location]);

  useEffect(() => {
    track('page_view', { path: location });
  }, [location, track]);

  return <>{children}</>;
}
