import { useGetPublicGoogleReviews } from '@workspace/api-client-react';
import { GOOGLE_REVIEWS } from '@/content/reviews';

export interface DisplayReview {
  /** Text of the review */
  quote: string;
  /** "First L." from Google, or "Homeowner, City" from fallback */
  who: string;
  /** 1–5 */
  rating: number;
  /** e.g. "3 months ago", or empty string for fallback */
  relativeDate: string;
}

/** Hardcoded reviews normalised to DisplayReview */
const FALLBACK_REVIEWS: DisplayReview[] = GOOGLE_REVIEWS.map((r) => ({
  quote: r.quote,
  who: r.who,
  rating: r.rating,
  relativeDate: '',
}));

/**
 * Returns live Google reviews fetched from the API server, falling back to the
 * hardcoded reviews in `content/reviews.ts` when the API is unavailable or
 * returns no results.
 */
export function useReviews(): { reviews: DisplayReview[]; isLive: boolean } {
  const { data } = useGetPublicGoogleReviews({
    query: {
      queryKey: ['google-reviews'],
      staleTime: 60 * 60 * 1000, // 1 hour client-side
      retry: 1,
      refetchOnWindowFocus: false,
    },
  });

  if (data && !data.isFallback && data.reviews?.length > 0) {
    const reviews: DisplayReview[] = data.reviews.map((r) => ({
      quote: r.text,
      who: r.reviewerName,
      rating: r.rating,
      relativeDate: r.relativeDate,
    }));
    return { reviews, isLive: true };
  }

  return { reviews: FALLBACK_REVIEWS, isLive: false };
}
