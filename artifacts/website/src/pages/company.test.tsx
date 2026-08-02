/**
 * Guards the reviews section of the company/reviews page against the
 * `isFallback: true` state returned by /api/public/google-reviews when no API
 * key or Place ID is configured.  The page must render the hardcoded fallback
 * reviews rather than crashing or showing a blank section.
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

vi.mock('@/lib/site-config', () => ({
  useBusiness: () => ({
    name: 'Painless Roofing',
    phone: '(404) 444-4476',
    phoneHref: 'tel:+14044444476',
    tagline: 'Painless from start to finish.',
    googleReviewUrl: 'https://g.page/r/test/review',
    facebook: 'https://facebook.com/painlessroofing',
  }),
  useSiteConfig: () => ({
    business: {
      name: 'Painless Roofing',
      phone: '(404) 444-4476',
      phoneHref: 'tel:+14044444476',
      tagline: 'Painless from start to finish.',
      googleReviewUrl: 'https://g.page/r/test/review',
      facebook: 'https://facebook.com/painlessroofing',
    },
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
  breadcrumbJsonLd: () => ({}),
  localBusinessJsonLd: () => ({}),
}));

vi.mock('@/components/page-blocks', () => ({
  Breadcrumbs: () => null,
  CtaSection: () => null,
  PageHero: ({ title }: { title?: string }) => <div>{title}</div>,
  SectionHeading: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock('@/components/google-review-cta', () => ({
  GoogleReviewCta: () => null,
}));

/* -------------------- lazy import after mocks -------------------- */

const { ReviewsPage } = await import('@/pages/company');

/* -------------------- helpers -------------------- */

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ReviewsPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/* -------------------- tests -------------------- */

describe('ReviewsPage reviews section — isFallback: true', () => {
  it('renders hardcoded fallback reviews when the API returns isFallback: true', () => {
    // Simulate the "no credentials configured" response
    useGetPublicGoogleReviews.mockReturnValue({
      data: { reviews: [], isFallback: true },
    });

    renderPage();

    // The page hero title must be present — the section must not crash
    expect(
      screen.getByText(/the work speaks\. so do the homeowners\./i),
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
      screen.getByText(/the work speaks\. so do the homeowners\./i),
    ).toBeDefined();
    expect(
      screen.getByText(/they found the actual source of a leak/i),
    ).toBeDefined();
  });

  it('does not render any review cards that arrived with isFallback: true (live data with flag set)', () => {
    // Edge case: API returns populated reviews BUT still sets isFallback: true.
    // The hook ignores live reviews flagged as fallback, so hardcoded content
    // must still appear.
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
