import { Router, type IRouter, type Request, type Response } from "express";

import { rateLimit } from "../../lib/rateLimit";
import { resolvePublicOrg } from "../../middlewares/publicOrg";
import { getOrgSettings } from "../../services/settings";

const router: IRouter = Router();

interface GoogleReview {
  reviewerName: string;
  rating: number;
  relativeDate: string;
  text: string;
  profilePhotoUrl: string | null;
}

interface CacheEntry {
  reviews: GoogleReview[];
  fetchedAt: number;
}

// Keyed by organization id — public routes are multi-tenant (installation
// keys), so one org's reviews must never be served for another.
const reviewCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Set to true after a credentials change so that the very next successful
 * response is sent with Cache-Control: no-cache.  This prevents browsers and
 * CDNs from re-caching the freshly-fetched reviews for another max-age period,
 * allowing them to pick up the new data on their next request instead of
 * waiting up to an hour for the old cached response to expire.
 */
let reviewCacheJustCleared = false;

/** Invalidate the in-memory reviews cache (call after org settings change). */
export function clearReviewCache(): void {
  reviewCache.clear();
  reviewCacheJustCleared = true;
}

/** Format "John Smith" → "John S." */
function formatReviewerName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (!parts[0]) return "Homeowner";
  if (parts.length === 1) return parts[0];
  const last = parts[parts.length - 1];
  return `${parts[0]} ${last[0].toUpperCase()}.`;
}

/** Sentinel used internally to distinguish "no credentials" from an empty list. */
const NO_CREDENTIALS = Symbol("NO_CREDENTIALS");

async function fetchFromGooglePlaces(
  apiKey: string,
  placeId: string,
): Promise<GoogleReview[]> {
  const url =
    `https://maps.googleapis.com/maps/api/place/details/json` +
    `?place_id=${encodeURIComponent(placeId)}` +
    `&fields=reviews` +
    `&reviews_sort=newest` +
    `&key=${apiKey}`;

  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`Google Places API returned HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    result?: { reviews?: Array<{
      author_name?: string;
      rating?: number;
      relative_time_description?: string;
      text?: string;
      profile_photo_url?: string;
    }> };
    status?: string;
  };

  if (data.status && data.status !== "OK") {
    throw new Error(`Google Places API status: ${data.status}`);
  }

  const rawReviews = data?.result?.reviews ?? [];

  return rawReviews
    .filter((r) => (r.rating ?? 0) >= 4 && r.text?.trim())
    .map((r) => ({
      reviewerName: formatReviewerName(r.author_name ?? "Homeowner"),
      rating: Math.min(5, Math.max(1, Math.round(r.rating ?? 5))),
      relativeDate: r.relative_time_description ?? "",
      text: (r.text ?? "").trim(),
      profilePhotoUrl: r.profile_photo_url ?? null,
    }));
}

router.get(
  "/public/google-reviews",
  rateLimit({ windowMs: 60_000, max: 60, key: "google-reviews" }),
  resolvePublicOrg(),
  async (req: Request, res: Response): Promise<void> => {
    const now = Date.now();
    const orgId = req.publicOrg!.id;

    // Serve fresh cache if available
    const cached = reviewCache.get(orgId);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.json({ reviews: cached.reviews, isFallback: false });
      return;
    }

    // Resolve credentials: org settings take priority, env vars are fallback.
    // If the org has a googleReviews settings entry (even with an empty apiKey),
    // we do NOT fall back to env vars — an intentional clear must be respected.
    let apiKey: string | undefined;
    let placeId: string | undefined;
    let orgHasGoogleReviewsEntry = false;

    try {
      {
        const settings = await getOrgSettings(orgId);
        if (settings.googleReviews != null) {
          orgHasGoogleReviewsEntry = true;
          apiKey = settings.googleReviews.apiKey?.trim() || undefined;
          placeId = settings.googleReviews.placeId?.trim() || undefined;
        }
      }
    } catch {
      // If org lookup fails, fall through to env var check below
    }

    // Fall back to environment variables only when the org has no googleReviews
    // settings entry at all (i.e. never configured, not intentionally cleared).
    if (!orgHasGoogleReviewsEntry) {
      if (!apiKey) apiKey = process.env.GOOGLE_PLACES_API_KEY;
      if (!placeId) placeId = process.env.GOOGLE_PLACE_ID;
    }

    if (!apiKey || !placeId) {
      res.setHeader("Cache-Control", "no-store");
      res.json({ reviews: [], isFallback: true });
      return;
    }

    try {
      const result = await fetchFromGooglePlaces(apiKey, placeId);
      reviewCache.set(orgId, { reviews: result, fetchedAt: now });
      // If credentials were just changed the admin cleared the cache.  Send
      // no-cache for this one response so browsers and CDNs are forced to
      // revalidate on the next request rather than serving the old data for
      // up to another hour.
      const justCleared = reviewCacheJustCleared;
      reviewCacheJustCleared = false;
      res.setHeader(
        "Cache-Control",
        justCleared ? "no-cache" : "public, max-age=3600",
      );
      res.json({ reviews: result, isFallback: false });
    } catch (err) {
      req.log.error({ err }, "Failed to fetch Google reviews");
      // Serve stale cache rather than nothing; flag as fallback since data may be outdated
      const stale = reviewCache.get(orgId);
      if (stale) {
        res.setHeader("Cache-Control", "public, max-age=300");
        res.json({ reviews: stale.reviews, isFallback: true });
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({ reviews: [], isFallback: true });
    }
  },
);

export default router;
