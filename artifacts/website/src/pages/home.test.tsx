/**
 * Guards the reviews section of the home page against the `isFallback: true`
 * state returned by /api/public/google-reviews when no API key or Place ID is
 * configured.  The page must render the hardcoded fallback reviews rather than
 * crashing or showing a blank section.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

/* -------------------- api-client mock -------------------- */

const useGetPublicGoogleReviews = vi.fn();

vi.mock('@workspace/api-client-react', () => ({
  useGetPublicGoogleReviews: (...args: unknown[]) =>
    useGetPublicGoogleReviews(...args),
}));

/* -------------------- analytics mock -------------------- */

vi.mock('@/lib/analytics', () => ({
  useAnalytics: () => ({ track: vi.fn() }),
  AnalyticsProvider: ({ children }: { children: React.ReactNode }) => children,
}));

/* -------------------- site-config mock -------------------- */

const mockIcon = () => null;
mockIcon.displayName = 'MockIcon';

vi.mock('@/lib/site-config', () => ({
  useSiteConfig: () => ({
    business: {
      name: 'Painless Roofing',
      phone: '(404) 444-4476',
      phoneHref: 'tel:+14044444476',
      googleReviewUrl: 'https://g.page/r/test/review',
    },
    services: [
      { slug: 'roof-repair', name: 'Roof Repair', teaser: 'Fix leaks fast.', icon: mockIcon },
      { slug: 'replacement', name: 'Replacement', teaser: 'Full replacement.', icon: mockIcon },
    ],
    areas: [
      { slug: 'canton', city: 'Canton' },
      { slug: 'alpharetta', city: 'Alpharetta' },
    ],
  }),
}));

/* -------------------- wouter mock -------------------- */

vi.mock('wouter', async () => {
  const actual = await vi.importActual<typeof import('wouter')>('wouter');
  return { ...actual, useSearch: () => '' };
});

/* -------------------- seo / page-blocks stubs -------------------- */

vi.mock('@/lib/seo', () => ({
  Seo: () => null,
  faqJsonLd: () => ({}),
  localBusinessJsonLd: () => ({}),
}));

vi.mock('@/components/page-blocks', () => ({
  Breadcrumbs: () => null,
  CtaSection: () => null,
  FaqList: () => null,
  SectionHeading: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

/* -------------------- framer-motion stub -------------------- */

vi.mock('framer-motion', () => ({
  motion: new Proxy(
    {},
    {
      get: (_target, prop: string) =>
        ({ children, ...rest }: React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }) =>
          React.createElement(prop as string, rest, children),
    },
  ),
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => children,
}));

/* -------------------- lazy import after mocks -------------------- */

const { default: HomePage } = await import('@/pages/home');

/* -------------------- helpers -------------------- */

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <HomePage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/* -------------------- tests -------------------- */

describe('HomePage reviews section — isFallback: true', () => {
  it('renders hardcoded fallback reviews when the API returns isFallback: true', () => {
    // Simulate the "no credentials configured" response
    useGetPublicGoogleReviews.mockReturnValue({
      data: { reviews: [], isFallback: true },
    });

    renderPage();

    // The section heading must be present — the section must not be blank/hidden
    expect(
      screen.getByText(/homeowners put it better than we can/i),
    ).toBeDefined();

    // At least one hardcoded fallback review must be visible — confirmed by
    // a fragment of the first entry in content/reviews.ts
    expect(
      screen.getByText(/they found the actual source of a leak/i),
    ).toBeDefined();
  });

  it('renders hardcoded fallback reviews when the API query is still loading (data undefined)', () => {
    useGetPublicGoogleReviews.mockReturnValue({ data: undefined });

    renderPage();

    expect(
      screen.getByText(/homeowners put it better than we can/i),
    ).toBeDefined();
    expect(
      screen.getByText(/they found the actual source of a leak/i),
    ).toBeDefined();
  });

  it('does not render any review cards that arrived with isFallback: true (live data with flag set)', () => {
    // Edge case: API returns populated reviews BUT still sets isFallback: true
    // (e.g. stale cache served after a fetch error).  The hook ignores live
    // reviews flagged as fallback, so hardcoded content must still appear.
    useGetPublicGoogleReviews.mockReturnValue({
      data: {
        isFallback: true,
        reviews: [
          {
            reviewerName: 'Live R.',
            rating: 5,
            relativeDate: '1 week ago',
            text: 'A stale live review that should not appear',
            profilePhotoUrl: null,
          },
        ],
      },
    });

    renderPage();

    // Hardcoded fallback review must appear
    expect(
      screen.getByText(/they found the actual source of a leak/i),
    ).toBeDefined();

    // The stale live review text must NOT appear — the hook discards it
    expect(
      screen.queryByText(/a stale live review that should not appear/i),
    ).toBeNull();
  });

  it('renders live Google reviews when isFallback is false and reviews are present', () => {
    useGetPublicGoogleReviews.mockReturnValue({
      data: {
        isFallback: false,
        reviews: [
          {
            reviewerName: 'Jane D.',
            rating: 5,
            relativeDate: '2 weeks ago',
            text: 'Excellent work on our roof replacement.',
            profilePhotoUrl: null,
          },
        ],
      },
    });

    renderPage();

    expect(
      screen.getByText(/excellent work on our roof replacement/i),
    ).toBeDefined();
    // Hardcoded fallback must NOT appear when live reviews are present
    expect(
      screen.queryByText(/they found the actual source of a leak/i),
    ).toBeNull();
  });
});
