/**
 * Convert gallery JPEGs to WebP at multiple sizes for responsive srcset.
 *
 * Outputs per card image (job-02…job-12, fb-job-*):
 *   <name>-400.webp  — mobile card / thumbnail
 *   <name>-800.webp  — desktop card (max single-column width)
 *
 * Outputs for the hero background (fb-job-01):
 *   fb-job-01-800.webp   — mobile hero
 *   fb-job-01-1440.webp  — desktop hero
 *
 * Legacy single-size files (job-01.webp … job-12.webp) are also kept for
 * backward compatibility. job-01-hero.webp (1440px) is kept as-is.
 */
import sharp from 'sharp';
import { readdirSync, statSync } from 'fs';
import { join, extname, basename } from 'path';

const galleryDir = new URL('../public/gallery', import.meta.url).pathname;

const files = readdirSync(galleryDir)
  .filter(f => extname(f).toLowerCase() === '.jpg')
  .sort();

for (const file of files) {
  const src = join(galleryDir, file);
  const name = basename(file, '.jpg');

  // ── Legacy single-size output (preserves existing behaviour) ────────────
  // job-01 hero: keep 1440px legacy file
  // other jobs: keep 800px legacy file
  const isHero = name === 'job-01';
  const legacyMaxWidth = isHero ? 1440 : 800;
  const legacyQuality = isHero ? 85 : 82;
  const legacyDest = join(galleryDir, `${name}.webp`);

  const legacyInfo = await sharp(src)
    .resize({ width: legacyMaxWidth, withoutEnlargement: true })
    .webp({ quality: legacyQuality })
    .toFile(legacyDest);

  const origSize = statSync(src).size;
  const legacySaving = (((origSize - legacyInfo.size) / origSize) * 100).toFixed(1);
  console.log(`${file} → ${name}.webp  ${(legacyInfo.size / 1024).toFixed(0)} KB  (saved ${legacySaving}%)`);

  // ── Multi-size variants for srcset ──────────────────────────────────────
  const sizes = [
    { suffix: '-400', width: 400, quality: 82 },
    { suffix: '-800', width: 800, quality: 82 },
  ];

  // fb-job-01 also serves as the home-page hero background — add a 1440px cut
  if (name === 'fb-job-01') {
    sizes.push({ suffix: '-1440', width: 1440, quality: 85 });
  }

  for (const { suffix, width, quality } of sizes) {
    const dest = join(galleryDir, `${name}${suffix}.webp`);
    const info = await sharp(src)
      .resize({ width, withoutEnlargement: true })
      .webp({ quality })
      .toFile(dest);
    console.log(`  → ${name}${suffix}.webp  ${(info.size / 1024).toFixed(0)} KB`);
  }
}

// job-01-hero.webp (1440px) — re-generate from job-01.jpg to keep it fresh
const heroSrc = join(galleryDir, 'job-01.jpg');
const heroDest = join(galleryDir, 'job-01-hero.webp');
const heroInfo = await sharp(heroSrc)
  .resize({ width: 1440, withoutEnlargement: true })
  .webp({ quality: 85 })
  .toFile(heroDest);
console.log(`job-01.jpg → job-01-hero.webp  ${(heroInfo.size / 1024).toFixed(0)} KB`);

console.log('\nDone.');
