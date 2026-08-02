import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { OG_CARD_BRAND } from "./ogCard";

/**
 * The website ships committed share-card PNGs generated at build time by
 * artifacts/website/scripts/generate-og-images.mjs (ImageMagick), while the
 * API renders cards at runtime for config-added areas (ogCard.ts). These are
 * two independent renderers of the same brand design. This test parses the
 * website script and asserts its brand tokens match OG_CARD_BRAND, so a
 * design tweak in one renderer fails CI until the other is updated too.
 */

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(
  moduleDir,
  "../../../website/scripts/generate-og-images.mjs",
);
const script = readFileSync(scriptPath, "utf8");

/** Extracts the first capture group or fails with a pointer to the script. */
function extract(re: RegExp, what: string): string {
  const m = script.match(re);
  if (!m?.[1]) {
    throw new Error(
      `could not find ${what} in generate-og-images.mjs — its shape changed; ` +
        "update this parity test and OG_CARD_BRAND in ogCard.ts together.",
    );
  }
  return m[1];
}

describe("OG share-card brand parity (website script vs API renderer)", () => {
  it("uses the same navy background color", () => {
    expect(extract(/const NAVY = '([^']+)'/, "NAVY")).toBe(OG_CARD_BRAND.navy);
  });

  it("uses the same sky accent color", () => {
    expect(extract(/const ACCENT = '([^']+)'/, "ACCENT")).toBe(
      OG_CARD_BRAND.accent,
    );
  });

  it("uses the same card dimensions", () => {
    const dims = `${OG_CARD_BRAND.width}x${OG_CARD_BRAND.height}`;
    expect(script).toContain(`'-extent', '${dims}'`);
    expect(script).toContain(`'-size', '${dims}'`);
  });

  it("uses DejaVu Sans for both weights", () => {
    expect(extract(/const FONT_BOLD = '([^']+)'/, "FONT_BOLD")).toContain(
      "DejaVuSans-Bold",
    );
    expect(extract(/const FONT = '([^']+)'/, "FONT")).toContain(
      "DejaVuSans.ttf",
    );
    expect(OG_CARD_BRAND.fontFamily).toBe("DejaVu Sans");
  });

  it("uses the same type scale (headline / subline / brand line)", () => {
    // The script annotates headline, subline, then brand line in order.
    const sizes = [...script.matchAll(/'-pointsize', '(\d+)'/g)].map((m) =>
      Number(m[1]),
    );
    expect(sizes).toEqual([
      OG_CARD_BRAND.headlineSize,
      OG_CARD_BRAND.sublineSize,
      OG_CARD_BRAND.brandLineSize,
    ]);
  });

  it("uses the same subline text color", () => {
    expect(
      extract(/'-pointsize', '30', '-fill', '([^']+)'/, "subline fill"),
    ).toBe(OG_CARD_BRAND.sublineColor);
  });

  it("builds the brand footer line with the same separator and suffix", () => {
    const brandLine = extract(
      /'-annotate', '\+\d+\+\d+', '([^']*Open 24\/7[^']*)'/,
      "brand footer annotate line",
    );
    expect(brandLine).toContain(OG_CARD_BRAND.brandSeparator);
    expect(brandLine.endsWith(OG_CARD_BRAND.brandSuffix)).toBe(true);
    // name • phone • suffix — three segments, like the API's brand line.
    expect(brandLine.split(OG_CARD_BRAND.brandSeparator)).toHaveLength(3);
  });

  it("draws the same footer accent bar", () => {
    expect(script).toContain(
      `'-size', '${OG_CARD_BRAND.width}x${OG_CARD_BRAND.footerBarHeight}', \`xc:\${ACCENT}\``,
    );
  });

  it("uses the same left margin for text and logo", () => {
    const margins = [...script.matchAll(/'\+(\d+)\+\d+'/g)]
      .filter((m) => m[0] !== "'+0+0'") // footer bar is pinned to the corner
      .map((m) => Number(m[1]));
    expect(margins.length).toBeGreaterThan(0);
    for (const m of margins) expect(m).toBe(OG_CARD_BRAND.leftMargin);
  });
});
