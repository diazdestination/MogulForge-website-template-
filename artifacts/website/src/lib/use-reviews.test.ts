/**
 * Unit tests for the useReviews hook.
 *
 * Verifies that the hook correctly maps live Google review data and falls back
 * to the hardcoded reviews in content/reviews.ts whenever the API is
 * unavailable, returns isFallback: true, or returns an empty array.
 *
 * Runtime secrets (GOOGLE_PLACES_API_KEY / GOOGLE_PLACE_ID) are not required
 * here — the hook behaviour under every credential state is exercised by
 * controlling the return value of the mocked API-client hook.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

/* ------------------------------------------------------------------ */
/*  Mock the generated API-client hook                                  */
/* ------------------------------------------------------------------ */

const useGetPublicGoogleReviews = vi.fn();

vi.mock('@workspace/api-client-react', () => ({
  useGetPublicGoogleReviews: (...args: unknown[]) =>
    useGetPublicGoogleReviews(...args),
}));

/* ------------------------------------------------------------------ */
/*  Import under test (after mock is registered)                        */
/* ------------------------------------------------------------------ */

const { useReviews } = await import('@/lib/use-reviews');
const { GOOGLE_REVIEWS } = await import('@/content/reviews');

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return React.createElement(QueryClientProvider, { client: qc }, children);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/* ------------------------------------------------------------------ */
/*  Tests                                                               */
/* ------------------------------------------------------------------ */

describe('useReviews', () => {
  it('returns hardcoded fallback reviews while the query is still loading (data undefined)', () => {
    useGetPublicGoogleReviews.mockReturnValue({ data: undefined });

    const { result } = renderHook(() => useReviews(), { wrapper });

    expect(result.current.isLive).toBe(false);
    expect(result.current.reviews).toHaveLength(GOOGLE_REVIEWS.length);
    expect(result.current.reviews[0].quote).toBe(GOOGLE_REVIEWS[0].quote);
  });

  it('returns hardcoded fallback reviews when the API signals isFallback: true', () => {
    useGetPublicGoogleReviews.mockReturnValue({
      data: { isFallback: true, reviews: [] },
    });

    const { result } = renderHook(() => useReviews(), { wrapper });

    expect(result.current.isLive).toBe(false);
    expect(result.current.reviews).toHaveLength(GOOGLE_REVIEWS.length);
  });

  it('ignores live reviews that arrive with isFallback: true and uses hardcoded fallback', () => {
    useGetPublicGoogleReviews.mockReturnValue({
      data: {
        isFallback: true,
        reviews: [
          {
            reviewerName: 'Live R.',
            rating: 5,
            relativeDate: '1 week ago',
            text: 'Should not appear',
            profilePhotoUrl: null,
          },
        ],
      },
    });

    const { result } = renderHook(() => useReviews(), { wrapper });

    expect(result.current.isLive).toBe(false);
    expect(result.current.reviews.some((r) => r.quote === 'Should not appear')).toBe(false);
    expect(result.current.reviews[0].quote).toBe(GOOGLE_REVIEWS[0].quote);
  });

  it('returns hardcoded fallback when isFallback: false but reviews array is empty', () => {
    useGetPublicGoogleReviews.mockReturnValue({
      data: { isFallback: false, reviews: [] },
    });

    const { result } = renderHook(() => useReviews(), { wrapper });

    expect(result.current.isLive).toBe(false);
    expect(result.current.reviews).toHaveLength(GOOGLE_REVIEWS.length);
  });

  it('maps live Google reviews to DisplayReview shape when isFallback: false', () => {
    const liveReview = {
      reviewerName: 'Jane D.',
      rating: 5,
      relativeDate: '2 weeks ago',
      text: 'Excellent work on our roof replacement.',
      profilePhotoUrl: null,
    };

    useGetPublicGoogleReviews.mockReturnValue({
      data: { isFallback: false, reviews: [liveReview] },
    });

    const { result } = renderHook(() => useReviews(), { wrapper });

    expect(result.current.isLive).toBe(true);
    expect(result.current.reviews).toHaveLength(1);
    const [r] = result.current.reviews;
    expect(r.quote).toBe(liveReview.text);
    expect(r.who).toBe(liveReview.reviewerName);
    expect(r.rating).toBe(liveReview.rating);
    expect(r.relativeDate).toBe(liveReview.relativeDate);
  });

  it('sets relativeDate to empty string for hardcoded fallback reviews', () => {
    useGetPublicGoogleReviews.mockReturnValue({ data: undefined });

    const { result } = renderHook(() => useReviews(), { wrapper });

    result.current.reviews.forEach((r) => {
      expect(r.relativeDate).toBe('');
    });
  });

  it('passes query options (staleTime, retry, refetchOnWindowFocus) to the API hook', () => {
    useGetPublicGoogleReviews.mockReturnValue({ data: undefined });

    renderHook(() => useReviews(), { wrapper });

    const [callOptions] = useGetPublicGoogleReviews.mock.calls[0];
    expect(callOptions.query.staleTime).toBe(60 * 60 * 1000);
    expect(callOptions.query.retry).toBe(1);
    expect(callOptions.query.refetchOnWindowFocus).toBe(false);
  });
});
