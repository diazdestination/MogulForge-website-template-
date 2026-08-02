/**
 * Composes branded 1200x630 Open Graph share cards for key landing pages.
 *
 * Each card layers: an AI-generated photographic background
 * (attached_assets/generated_images/og-bg-*.png), a left-to-right dark navy
 * gradient (matching og-default.png's palette) so text stays readable, the
 * company logo, a page-specific headline/subline, and the sky-blue footer bar.
 *
 * Run manually after changing backgrounds or copy:
 *   node scripts/generate-og-images.mjs
 *
 * Outputs are committed to public/ so builds don't depend on ImageMagick.
 *
 * Brand tokens here (colors, fonts, type scale, footer bar, margins) must
 * stay in sync with the API's runtime renderer for config-added areas
 * (artifacts/api-server/src/services/ogCard.ts, OG_CARD_BRAND). The
 * api-server test og-card-brand-parity.test.ts parses this file and fails
 * when the two drift — update both renderers together.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(root, '..');
const pub = path.join(site, 'public');
const bgDir = path.resolve(site, '../../attached_assets/generated_images');

/**
 * The list of area cards is derived from src/content/areas.ts (the single
 * source of truth for service areas), so adding an area there automatically
 * demands a card here. Each area still needs a hand-written subline and a
 * background image; the script fails loudly when either is missing instead of
 * letting the new page silently fall back to og-default.png.
 */
function listAreaSlugsAndCities() {
  const src = readFileSync(path.join(site, 'src/content/areas.ts'), 'utf8');
  const areas = [];
  const re = /slug:\s*'([^']+)',\s*\n\s*city:\s*'([^']+)'/g;
  for (const m of src.matchAll(re)) areas.push({ slug: m[1], city: m[2] });
  if (areas.length === 0) {
    throw new Error('could not parse any areas from src/content/areas.ts — did its shape change?');
  }
  return areas;
}

const NAVY = '#0b1424';
const ACCENT = '#38bdf8';
const FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

/** Per-area card copy and background, keyed by area slug. */
const AREA_CARD_COPY = {
  'canton-ga': {
    bg: 'og-bg-area-canton.png',
    subline: 'Based right here in Canton — repair,\nreplacement & storm damage, 24/7.',
  },
  'atlanta-ga': {
    bg: 'og-bg-area-atlanta.png',
    subline: 'From intown bungalows to Buckhead —\nrepair, replacement & storm restoration.',
  },
  'dawsonville-ga': {
    bg: 'og-bg-area-dawsonville.png',
    subline: 'Wind-rated roofing built for foothill\nweather — storm damage & metal roofs.',
  },
  'cumming-ga': {
    bg: 'og-bg-area-cumming.png',
    subline: 'Roof replacement, repair & storm\nrestoration for Forsyth County homes.',
  },
  'alpharetta-ga': {
    bg: 'og-bg-area-alpharetta.png',
    subline: 'Architectural roofing done right —\nrepair, replacement & storm damage.',
  },
  'gainesville-ga': {
    bg: 'og-bg-area-gainesville.png',
    subline: 'Lake Lanier-area roofing — repair,\nreplacement & storm restoration.',
  },
  'woodstock-ga': {
    bg: 'og-bg-area-canton.png',
    subline: 'Cherokee County roofing — repair,\nreplacement & storm damage, 24/7.',
  },
  'marietta-ga': {
    bg: 'og-bg-area-atlanta.png',
    subline: 'Cobb County roofing — storm damage,\nrepair & full replacement.',
  },
  'roswell-ga': {
    bg: 'og-bg-area-alpharetta.png',
    subline: 'North Fulton roofing — historic homes\nto new builds, done right.',
  },
  'acworth-ga': {
    bg: 'og-bg-area-cumming.png',
    subline: 'Lake Allatoona-area roofing — storm\ndamage, repair & replacement.',
  },
  'kennesaw-ga': {
    bg: 'og-bg-area-atlanta.png',
    subline: 'Cobb County roofing — replacement,\nrepair & storm restoration.',
  },
  'cartersville-ga': {
    bg: 'og-bg-area-canton.png',
    subline: 'Bartow County roofing — storm damage,\nrepair & full replacement.',
  },
  'ball-ground-ga': {
    bg: 'og-bg-area-canton.png',
    subline: 'Cherokee County roofing — metal,\nrepair & storm damage, 24/7.',
  },
  'jasper-ga': {
    bg: 'og-bg-area-dawsonville.png',
    subline: 'Pickens County roofing — metal roofs,\nstorm damage & steep-pitch installs.',
  },
  'blue-ridge-ga': {
    bg: 'og-bg-area-dawsonville.png',
    subline: 'Mountain cabin roofing — standing-seam\nmetal, storm damage & inspections.',
  },
  'rome-ga': {
    bg: 'og-bg-area-gainesville.png',
    subline: 'Floyd County roofing — replacement,\nstorm damage & water restoration.',
  },
};

const areaCards = [];
const missingAreas = [];
for (const { slug, city } of listAreaSlugsAndCities()) {
  const copy = AREA_CARD_COPY[slug];
  if (!copy) {
    missingAreas.push(slug);
    continue;
  }
  areaCards.push({
    out: `og-area-${slug}.png`,
    bg: copy.bg,
    headline: `${city}, GA\nRoofing`,
    subline: copy.subline,
  });
}
if (missingAreas.length > 0) {
  console.error(
    `missing share-card copy for area(s): ${missingAreas.join(', ')} — ` +
      'add an AREA_CARD_COPY entry (subline + background) in scripts/generate-og-images.mjs, ' +
      'drop the background into attached_assets/generated_images/, then re-run this script.',
  );
  process.exitCode = 1;
}
const staleAreas = Object.keys(AREA_CARD_COPY).filter(
  (slug) => !areaCards.some((c) => c.out === `og-area-${slug}.png`),
);
if (staleAreas.length > 0) {
  console.error(`AREA_CARD_COPY has entries for unknown area slug(s): ${staleAreas.join(', ')}`);
  process.exitCode = 1;
}

const CARDS = [
  {
    out: 'og-nationwide.png',
    bg: 'og-bg-storm.png',
    headline: 'Nationwide\nRoofing',
    subline: 'Large-loss, commercial & out-of-state —\nwe travel anywhere in the Continental US.',
  },
  {
    out: 'og-storm-check.png',
    bg: 'og-bg-storm.png',
    headline: 'Storm Address\nChecker',
    subline: 'Check your Georgia address against\nrecent hail & wind activity — free.',
  },
  {
    out: 'og-service-roof-repair.png',
    bg: 'og-bg-repair.png',
    headline: 'Roof Repair',
    subline: 'Leaks, missing shingles & flashing\nfixed right — Canton & metro Atlanta.',
  },
  {
    out: 'og-service-roof-replacement.png',
    bg: 'og-bg-replacement.png',
    headline: 'Roof\nReplacement',
    subline: 'Full replacements with quality materials\nand clear communication.',
  },
  {
    out: 'og-service-storm-damage.png',
    bg: 'og-bg-storm.png',
    headline: 'Storm Damage\nRestoration',
    subline: 'Hail & wind damage assessed, documented\nand restored — insurance-ready.',
  },
  ...areaCards,
];

for (const card of CARDS) {
  const bg = path.join(bgDir, card.bg);
  if (!existsSync(bg)) {
    console.error(`missing background: ${bg}`);
    process.exitCode = 1;
    continue;
  }
  const out = path.join(pub, card.out);
  execFileSync('magick', [
    // Background photo, cover-cropped to 1200x630.
    bg, '-resize', '1200x630^', '-gravity', 'center', '-extent', '1200x630',
    // Dark navy wash + stronger right-side gradient for text legibility.
    '(', '-size', '1200x630', `xc:${NAVY}`, '-alpha', 'set', '-channel', 'A', '-evaluate', 'set', '55%', ')',
    '-composite',
    '(', '-size', '630x1200', 'gradient:none-black', '-rotate', '90', '-channel', 'A', '-evaluate', 'multiply', '0.75', ')',
    '-composite',
    // Logo.
    '(', path.join(pub, 'logo.png'), '-resize', 'x120', ')',
    '-gravity', 'northwest', '-geometry', '+72+64', '-composite',
    // Headline + subline + brand line.
    '-gravity', 'northwest',
    '-font', FONT_BOLD, '-pointsize', '72', '-fill', 'white',
    '-annotate', '+72+240', card.headline,
    '-font', FONT, '-pointsize', '30', '-fill', '#cbd5e1',
    '-annotate', '+72+448', card.subline,
    '-font', FONT_BOLD, '-pointsize', '26', '-fill', ACCENT,
    '-annotate', '+72+548', 'Painless Roofing & Water Restoration   •   (404) 444-4476   •   Open 24/7',
    // Footer accent bar.
    '(', '-size', '1200x14', `xc:${ACCENT}`, ')',
    '-gravity', 'southwest', '-geometry', '+0+0', '-composite',
    '-strip', 'PNG24:' + out,
  ]);
  console.log(`wrote ${path.relative(site, out)}`);
}
