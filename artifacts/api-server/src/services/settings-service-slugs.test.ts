import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DEFAULT_SERVICES, LEGACY_SERVICE_SLUGS } from "./settings";

/**
 * The website's rich service page copy is keyed by slug. A seeded default
 * service whose slug has no matching entry in the website's SERVICES content
 * list silently renders a generic fallback card (this bit the water
 * restoration page once already). This suite pins the contract:
 *
 * - every seeded default service slug must have rich website content
 * - every legacy alias must resolve to a real content slug
 *
 * The website content lives in a different package that imports lucide-react
 * icons, so we extract slugs from the source file rather than importing it.
 */

const WEBSITE_SERVICES_SOURCE = fileURLToPath(
  new URL("../../../website/src/content/services.ts", import.meta.url),
);

function loadWebsiteContentSlugs(): Set<string> {
  const source = readFileSync(WEBSITE_SERVICES_SOURCE, "utf8");
  // Entry slugs are object members at one indent level: `    slug: 'roof-repair',`
  // (relatedSlugs arrays and the interface declaration don't match this shape).
  const slugs = new Set<string>();
  for (const match of source.matchAll(/^\s{4}slug: '([^']+)',$/gm)) {
    slugs.add(match[1]);
  }
  return slugs;
}

describe("default service slugs match website page copy", () => {
  const contentSlugs = loadWebsiteContentSlugs();

  it("extracts the website content slugs (guard against parser drift)", () => {
    // If the website file moves or its formatting changes so the extraction
    // breaks, fail loudly instead of vacuously passing.
    expect(contentSlugs.size).toBeGreaterThanOrEqual(10);
    expect(contentSlugs.has("water-damage-restoration")).toBe(true);
    expect(contentSlugs.has("roof-repair")).toBe(true);
  });

  it("every seeded default service slug has rich website content", () => {
    const missing = DEFAULT_SERVICES.map((s) => s.slug).filter(
      (slug) => !contentSlugs.has(slug),
    );
    expect(
      missing,
      `Seeded default service slug(s) with no matching entry in the website's ` +
        `SERVICES content list — the site would render a generic fallback card. ` +
        `Either use an existing content slug, add rich copy to ` +
        `artifacts/website/src/content/services.ts, or map it in LEGACY_SERVICE_SLUGS.`,
    ).toEqual([]);
  });

  it("seeded default slugs are canonical, not legacy aliases", () => {
    const legacy = DEFAULT_SERVICES.map((s) => s.slug).filter(
      (slug) => slug in LEGACY_SERVICE_SLUGS,
    );
    expect(
      legacy,
      "Seed the canonical slug directly; LEGACY_SERVICE_SLUGS is only for migrating existing rows.",
    ).toEqual([]);
  });

  it("every legacy alias resolves to a real website content slug", () => {
    const dangling = Object.entries(LEGACY_SERVICE_SLUGS).filter(
      ([, canonical]) => !contentSlugs.has(canonical),
    );
    expect(
      dangling,
      "LEGACY_SERVICE_SLUGS must map to slugs that have rich website content.",
    ).toEqual([]);
  });

  it("no seeded slugs collide after legacy canonicalization", () => {
    const canonicalized = DEFAULT_SERVICES.map(
      (s) => LEGACY_SERVICE_SLUGS[s.slug] ?? s.slug,
    );
    expect(new Set(canonicalized).size).toBe(canonicalized.length);
  });
});
