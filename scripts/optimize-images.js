#!/usr/bin/env node
/**
 * Converts all project images to WebP.
 * - Applies EXIF orientation so the display matches the original JPG
 * - Resizes so neither dimension exceeds MAX_PX (preserving aspect ratio)
 * - Deletes existing .webp files first so every run starts clean
 *
 * Run manually : node scripts/optimize-images.js
 * Runs automatically before generate → before every build via npm hooks.
 */

const sharp = require('sharp');
const fs    = require('fs');
const path  = require('path');

const SOURCE_EXTS  = new Set(['.jpg', '.jpeg', '.png']);
const PROJECTS_DIR = path.join(__dirname, '..', 'assets', 'images', 'projects');
const MAX_PX       = 1920;   // neither width nor height will exceed this
const QUALITY      = 82;

async function run() {
  const folders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();

  // ── Step 1: delete all existing WebP files ──────────────────────────────────
  let deleted = 0;
  for (const folder of folders) {
    const dir = path.join(PROJECTS_DIR, folder);
    for (const file of fs.readdirSync(dir)) {
      if (path.extname(file).toLowerCase() === '.webp') {
        fs.unlinkSync(path.join(dir, file));
        deleted++;
      }
    }
  }
  if (deleted > 0) console.log(`[optimize] deleted ${deleted} existing .webp file(s)`);

  // ── Step 2: convert originals ───────────────────────────────────────────────
  let converted = 0;

  for (const folder of folders) {
    const dir   = path.join(PROJECTS_DIR, folder);
    const files = fs.readdirSync(dir)
      .filter(f => SOURCE_EXTS.has(path.extname(f).toLowerCase()))
      .sort();

    for (const file of files) {
      const inputPath  = path.join(dir, file);
      const outputFile = path.basename(file, path.extname(file)) + '.webp';
      const outputPath = path.join(dir, outputFile);

      // Read source dimensions for the log
      const meta = await sharp(inputPath).metadata();

      await sharp(inputPath)
        .rotate()   // apply EXIF orientation into pixels (required in sharp ≥ 0.32)
        .resize({
          width:             MAX_PX,
          height:            MAX_PX,
          fit:               'inside',   // keeps aspect ratio, never exceeds MAX_PX on either axis
          withoutEnlargement: true,
        })
        .webp({ quality: QUALITY })
        .toFile(outputPath);

      // Read output dimensions for the log
      const outMeta = await sharp(outputPath).metadata();

      const inKB  = Math.round(fs.statSync(inputPath).size  / 1024);
      const outKB = Math.round(fs.statSync(outputPath).size / 1024);
      console.log(
        `[optimize] ${folder}/${file}  ${meta.width}x${meta.height} ${inKB}KB` +
        `  →  ${outMeta.width}x${outMeta.height} ${outKB}KB  (.webp)`
      );
      converted++;
    }
  }

  console.log(`[optimize] done — ${converted} image(s) converted`);
}

run().catch(err => {
  console.error('[optimize] error:', err.message);
  process.exit(1);
});
