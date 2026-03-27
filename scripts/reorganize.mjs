/**
 * Mixamo Pack Reorganizer
 *
 * Analyzes the Animations/ folder and moves pack files into subfolders:
 *   Animations/_Packs/{Pack Name}/{animation}.fbx
 *
 * Usage:
 *   node reorganize.mjs          — analysis only (dry-run, nothing is moved)
 *   node reorganize.mjs --move   — performs the actual move
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANIM_DIR   = path.join(__dirname, '..', 'Animations');
const CACHE_FILE = path.join(__dirname, '..', 'animations-cache.json');

const DRY_RUN = !process.argv.includes('--move');

function sanitize(name) {
  return name.replace(/[<>:"/\\|?*]+/g, '_').replace(/\s+/g, ' ').trim();
}

function loadCache() {
  if (!fs.existsSync(CACHE_FILE)) { console.error('Missing cache!'); process.exit(1); }
  return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')).anims;
}

async function main() {
  if (DRY_RUN) {
    console.log('=== ANALYSIS MODE (dry-run) — nothing will be moved ===');
    console.log('Use --move to actually perform the move.\n');
  } else {
    console.log('=== MOVE MODE ===\n');
  }

  const anims = loadCache();
  const files = new Set(fs.readdirSync(ANIM_DIR).filter(f => f.endsWith('.fbx')));

  // Build maps
  // regularSet: filenames that are standalone (non-pack) animations
  const regularSet = new Set();
  // packMap: filename -> [{packName, motionName}] — only unambiguous single-pack assignments
  const packMap = {}; // filename -> {packName, motionName, count}

  // Deduplicate packs (API sometimes returns same pack twice)
  const seenPacks = new Set();
  const uniquePacks = [];
  for (const anim of anims) {
    if (anim.type === 'MotionPack' && Array.isArray(anim.motions)) {
      const key = anim.name + '|' + anim.motions.length;
      if (!seenPacks.has(key)) {
        seenPacks.add(key);
        uniquePacks.push(anim);
      }
    } else {
      regularSet.add(sanitize(anim.description) + '.fbx');
    }
  }

  console.log(`Packs (after deduplication): ${uniquePacks.length}`);
  console.log(`Regular animations: ${regularSet.size}`);
  console.log(`Files in Animations/: ${files.size}\n`);

  // For each pack motion, track which packs claim it
  const packClaims = {}; // filename -> [packName, ...]
  for (const pack of uniquePacks) {
    for (const motion of pack.motions) {
      const fn = sanitize(motion.name) + '.fbx';
      if (!packClaims[fn]) packClaims[fn] = [];
      packClaims[fn].push(pack.name);
    }
  }

  // Categorize files
  const toMove   = []; // {file, fromPath, toDir, packName} — safe to move
  const conflict = []; // {file, packs} — claimed by multiple packs
  const regular  = []; // regular animations
  const unknown  = []; // not in cache at all

  for (const file of files) {
    const claims = packClaims[file];
    const isRegular = regularSet.has(file);

    if (isRegular) {
      regular.push(file);
    } else if (claims && claims.length === 1) {
      toMove.push({
        file,
        fromPath: path.join(ANIM_DIR, file),
        toDir:    path.join(ANIM_DIR, '_Packs', sanitize(claims[0])),
        packName: claims[0]
      });
    } else if (claims && claims.length > 1) {
      conflict.push({ file, packs: [...new Set(claims)] });
    } else {
      unknown.push(file);
    }
  }

  // Report
  console.log('── File analysis ───────────────────────────────────');
  console.log(`  Regular animations:                  ${regular.length}`);
  console.log(`  Pack files (unambiguous → to move):  ${toMove.length}`);
  console.log(`  Pack files (conflict between packs): ${conflict.length}`);
  console.log(`  Unknown (old naming scheme?):        ${unknown.length}`);
  console.log();

  // Show pack breakdown for movable files
  const packGroups = {};
  toMove.forEach(({ packName }) => {
    packGroups[packName] = (packGroups[packName] || 0) + 1;
  });
  console.log('── Files to move by pack ───────────────────────────');
  Object.entries(packGroups).sort((a,b) => b[1]-a[1]).forEach(([pack, count]) => {
    console.log(`  ${count.toString().padStart(3)}x  ${pack}`);
  });

  // Show conflicts
  if (conflict.length > 0) {
    console.log(`\n── Conflicts (${conflict.length} files claimed by multiple packs — staying in /Animations) ──`);
    conflict.slice(0, 15).forEach(({ file, packs }) => {
      console.log(`  "${file}"\n       → ${packs.join(', ')}`);
    });
    if (conflict.length > 15) console.log(`  ... and ${conflict.length - 15} more`);
  }

  if (DRY_RUN) {
    console.log(`\n════════════════════════════════════════════════════`);
    console.log(`Run with --move to move ${toMove.length} files to _Packs/.`);
    console.log(`Conflicting files (${conflict.length}) will stay in /Animations.`);
    return;
  }

  // ── Actually move files ──────────────────────────────────────────
  console.log(`\n── Moving ${toMove.length} files... ────────────────────────────`);

  let moved = 0, failed = 0;
  for (const { file, fromPath, toDir, packName } of toMove) {
    try {
      if (!fs.existsSync(toDir)) fs.mkdirSync(toDir, { recursive: true });
      const toPath = path.join(toDir, file);

      if (fs.existsSync(toPath)) {
        // Already exists in target — remove source duplicate
        fs.unlinkSync(fromPath);
      } else {
        fs.renameSync(fromPath, toPath);
      }
      moved++;
      if (moved % 50 === 0) process.stdout.write(`\r  Moved: ${moved}/${toMove.length}  `);
    } catch (err) {
      failed++;
      console.log(`\n  ERR: ${file} — ${err.message}`);
    }
  }

  console.log(`\r  Moved: ${moved}/${toMove.length}  `);
  if (failed > 0) console.log(`  Errors: ${failed}`);

  console.log(`\n════════════════════════════════════════════════════`);
  console.log(`Done! _Packs/ contains ${moved} animations in ${Object.keys(packGroups).length} subfolders.`);
  console.log(`Conflicts (${conflict.length}) and unknown (${unknown.length}) stayed in /Animations.`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
