/**
 * Mixamo GIF Preview Downloader
 * Downloads animated preview GIFs for all animations, mirroring FBX folder structure:
 *   _GIF/{name}.gif                          — regular animations
 *   _GIF/_Packs/{Pack Name}/{name}.gif       — pack animations
 *
 * Usage:
 *   node download-gifs.mjs                             — without packs (fast, no token needed)
 *   set MIXAMO_TOKEN=<bearer> && node download-gifs.mjs  — with packs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CACHE_FILE   = path.join(__dirname, 'animations-cache.json');
// GIFs go inside the animations folder: first CLI arg or default
const ANIM_DIR     = process.argv[2] || path.join(__dirname, 'Animations');
const OUTPUT_DIR   = path.join(ANIM_DIR, '_GIF');
const DELAY_MS     = 50;
const CONCURRENCY  = 8;

const BEARER       = process.env.MIXAMO_TOKEN || '';
const CHARACTER_ID = process.env.MIXAMO_CHARACTER || '721c276f-a08a-406a-bcf0-6a9e3c607770';

function sanitize(name) {
  return name.replace(/[<>:"/\\|?*]+/g, '_').replace(/\s+/g, ' ').trim();
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadCache() {
  if (!fs.existsSync(CACHE_FILE)) {
    console.error('Missing animations-cache.json!');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')).anims;
}

// Deduplicate packs (API sometimes returns duplicates)
function getUniquePacks(anims) {
  const seen = new Set();
  return anims.filter(a => {
    if (a.type !== 'MotionPack' || !Array.isArray(a.motions)) return false;
    const key = a.name + '|' + a.motions.length;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchProductThumbnail(productId) {
  if (!BEARER) throw new Error('Missing MIXAMO_TOKEN');
  const url = `https://www.mixamo.com/api/v1/products/${productId}?similar=0&character_id=${CHARACTER_ID}`;
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${BEARER}`,
      'X-Api-Key': 'mixamo2'
    }
  });
  if (!res.ok) throw new Error(`Product ${res.status}`);
  const data = await res.json();
  return data.thumbnail_animated || data.thumbnail || null;
}

async function downloadGif(gifUrl, filepath) {
  const res = await fetch(gifUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(filepath, buf);
  return buf.length;
}

async function runConcurrent(tasks, n) {
  let idx = 0;
  const results = new Array(tasks.length);
  async function worker() {
    while (idx < tasks.length) { const i = idx++; results[i] = await tasks[i](); }
  }
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
  return results;
}

async function main() {
  const anims = loadCache();
  const uniquePacks = getUniquePacks(anims);
  const regularAnims = anims.filter(a => a.type !== 'MotionPack');

  console.log(`Cache: ${regularAnims.length} regular, ${uniquePacks.length} packs`);
  console.log(`Token: ${BEARER ? 'set (packs will be downloaded)' : 'missing (packs skipped)'}`);
  console.log();

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Build job list: {outPath, gifUrl, productId, label}
  const jobs = [];

  // Regular animations — URL in cache, no token needed
  for (const anim of regularAnims) {
    const filename = sanitize(anim.description) + '.gif';
    jobs.push({
      label:     anim.description,
      outPath:   path.join(OUTPUT_DIR, filename),
      gifUrl:    anim.thumbnail_animated || null,
      productId: null,
    });
  }

  // Pack motions — do _Packs/{PackName}/ subfolder
  // Force re-download pack GIFs even if they exist (may be pack thumbnail, not individual)
  const FORCE_PACK_REGIF = !!BEARER;
  let packMotionCount = 0;
  for (const pack of uniquePacks) {
    const packFolder = path.join(OUTPUT_DIR, '_Packs', sanitize(pack.name));
    for (const motion of pack.motions) {
      const filename = sanitize(motion.name) + '.gif';
      jobs.push({
        label:      `${pack.name} / ${motion.name}`,
        outPath:    path.join(packFolder, filename),
        gifUrl:     null,
        productId:  motion.product_id,
        packFolder,
        forceRefetch: FORCE_PACK_REGIF, // re-fetch to replace pack thumbnail with individual
      });
      packMotionCount++;
    }
  }

  console.log(`Jobs: ${jobs.length} GIFs (${regularAnims.length} regular + ${packMotionCount} from packs)`);
  if (packMotionCount > 0 && !BEARER) {
    console.warn(`WARNING: ${packMotionCount} pack animations will be skipped (no token)\n`);
  }

  let downloaded = 0, skipped = 0, failed = 0;

  const tasks = jobs.map((job, i) => async () => {
    // Skip pack motions without token
    if (!job.gifUrl && job.productId && !BEARER) { failed++; return; }

    // Ensure output folder exists (for pack subfolders)
    if (job.packFolder && !fs.existsSync(job.packFolder)) {
      fs.mkdirSync(job.packFolder, { recursive: true });
    }

    if (fs.existsSync(job.outPath) && !job.forceRefetch) {
      skipped++;
      return;
    }

    try {
      let gifUrl = job.gifUrl;

      if (!gifUrl && job.productId) {
        gifUrl = await fetchProductThumbnail(job.productId);
        if (!gifUrl) throw new Error('No thumbnail_animated found');
        await sleep(30);
      }

      if (!gifUrl) { failed++; return; }

      const bytes = await downloadGif(gifUrl, job.outPath);
      downloaded++;
      process.stdout.write(`\r[${i+1}/${jobs.length}] +${downloaded} downloaded, ${skipped} skipped, ${failed} errors   `);
      await sleep(DELAY_MS);
    } catch (err) {
      failed++;
      process.stdout.write(`\r[${i+1}/${jobs.length}] ERR: ${job.label} — ${err.message}\n`);
    }
  });

  await runConcurrent(tasks, CONCURRENCY);

  console.log(`\n\nDone!`);
  console.log(`  Downloaded: ${downloaded}`);
  console.log(`  Skipped:    ${skipped}`);
  console.log(`  Errors:     ${failed}`);
  console.log(`\nFolder structure:`);
  console.log(`  ${OUTPUT_DIR}/`);
  console.log(`    *.gif              — regular animations`);
  console.log(`    _Packs/`);
  console.log(`      {Pack Name}/`);
  console.log(`        *.gif          — pack animations`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
