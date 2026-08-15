/**
 * Guards the reviews section of the company/reviews page against the
 * `isFallback: true` state returned by /api/public/google-reviews when no API
 * key or Place ID is configured.  The page must render the hardcoded fallback
 * reviews rather than crashing or showing a blank section.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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

const { ReviewsPage, GalleryPage } = await import('@/pages/company');

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

describe('GalleryPage — gallery images render correctly', () => {
  it('renders 12 gallery job photo images', () => {
    render(<GalleryPage />);
    const imgs = document.querySelectorAll('img[src*="gallery/job-"]');
    // All 12 project photos must appear — none silently dropped.
    expect(imgs.length).toBe(12);
  });

  it('gallery image src attributes are derived from BASE_URL, not bare strings', () => {
    render(<GalleryPage />);
    const imgs = document.querySelectorAll('img[src*="gallery/job-"]');
    expect(imgs.length).toBeGreaterThan(0);
    for (const img of Array.from(imgs)) {
      const attr = img.getAttribute('src') ?? '';
      // The attribute must include the BASE_URL prefix.  In vitest, BASE_URL
      // is "/" so the full path is "/gallery/job-XX.jpg" — the invariant is
      // that every src starts with the BASE_URL value, meaning it was
      // constructed via template literal, not hardcoded independently.
      // We verify this by checking the attr starts with import.meta.env.BASE_URL.
      expect(attr.startsWith(import.meta.env.BASE_URL)).toBe(true);
      expect(attr).toContain('gallery/job-');
    }
  });

  it('WebP job images fall back to JPEG: <source> carries the .webp and <img> src is .jpg', () => {
    render(<GalleryPage />);
    // Every <source type="image/webp"> must reference .webp files (srcset may
    // be a responsive descriptor list like "foo-400.webp 400w, foo-800.webp 800w")
    const sources = document.querySelectorAll<HTMLSourceElement>('source[type="image/webp"]');
    expect(sources.length).toBeGreaterThan(0);
    for (const src of Array.from(sources)) {
      expect(src.srcset).toContain('.webp');
    }
    // The corresponding <img> inside each <picture> must have the .jpg fallback
    const pictures = document.querySelectorAll('picture');
    for (const pic of Array.from(pictures)) {
      const img = pic.querySelector('img');
      expect(img).not.toBeNull();
      expect(img!.getAttribute('src')).toMatch(/\.jpg$/);
    }
  });

  it('becomes visible immediately when the image was already decoded before mount (cached asset)', async () => {
    // Simulate a browser that had the images cached: .complete is true and
    // naturalWidth is positive before React attaches the onLoad listener.
    const originalComplete = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'complete');
    const originalNaturalWidth = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'naturalWidth');

    Object.defineProperty(HTMLImageElement.prototype, 'complete', { configurable: true, get: () => true });
    Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => 400 });

    try {
      await act(async () => { render(<GalleryPage />); });

      const imgs = document.querySelectorAll<HTMLImageElement>('img[src*="gallery/"]');
      expect(imgs.length).toBeGreaterThan(0);
      for (const img of Array.from(imgs)) {
        // The useEffect must have detected img.complete and set loaded=true,
        // so opacity-0 must be absent and opacity-100 must be present.
        expect(img.classList.contains('opacity-0')).toBe(false);
        expect(img.classList.contains('opacity-100')).toBe(true);
      }
    } finally {
      if (originalComplete) Object.defineProperty(HTMLImageElement.prototype, 'complete', originalComplete);
      if (originalNaturalWidth) Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', originalNaturalWidth);
    }
  });

  it('shows a branded placeholder when an image fails to load', async () => {
    await act(async () => { render(<GalleryPage />); });

    const img = document.querySelector<HTMLImageElement>('img[src*="gallery/"]');
    expect(img).not.toBeNull();

    // Image starts hidden (skeleton visible) because jsdom never fires onLoad
    expect(img!.classList.contains('opacity-0')).toBe(true);

    // Capture the alt text so we can find the replacement placeholder
    const altText = img!.getAttribute('alt') ?? '';

    // Fire an error event (e.g. 404 or network timeout on the fallback JPEG)
    await act(async () => { fireEvent.error(img!); });

    // The broken image is replaced by a branded placeholder that carries the
    // original alt text as its accessible label — the card stays presentable.
    const placeholder = document.querySelector(`[role="img"][aria-label="${altText}"]`);
    expect(placeholder).not.toBeNull();

    // The original <img> element must be gone (replaced by the placeholder div)
    expect(document.querySelector(`img[alt="${altText}"]`)).toBeNull();
  });
});

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
