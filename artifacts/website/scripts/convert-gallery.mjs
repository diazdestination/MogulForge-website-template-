/**
 * Convert gallery JPEGs to WebP.
 * - Cards (job-02 through job-12): max 800px wide, quality 82
 * - Hero (job-01): max 1440px wide (already ≤1920), quality 85
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
  const dest = join(galleryDir, `${name}.webp`);

  // job-01 is the hero: keep full 1440px width, slightly higher quality
  const isHero = name === 'job-01';
  const maxWidth = isHero ? 1440 : 800;
  const quality = isHero ? 85 : 82;

  const info = await sharp(src)
    .resize({ width: maxWidth, withoutEnlargement: true })
    .webp({ quality })
    .toFile(dest);

  const origSize = statSync(src).size;
  const saving = (((origSize - info.size) / origSize) * 100).toFixed(1);
  console.log(`${file} → ${name}.webp  ${(info.size / 1024).toFixed(0)} KB  (saved ${saving}%)`);
}

console.log('\nDone.');
