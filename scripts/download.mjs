#!/usr/bin/env node
/**
 * Mixamo Batch Animation Downloader
 *
 * Downloads all animations from Mixamo for a given character.
 * No browser popups - everything goes straight to disk.
 *
 * Usage:
 *   1. Log into mixamo.com in your browser
 *   2. Open DevTools (F12) > Console
 *   3. Type: localStorage.access_token  (and copy the result)
 *   4. Run: node download.mjs <YOUR_TOKEN>
 *        or: node download.mjs  (will prompt for token)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANIMATIONS_DIR = path.join(__dirname, '..', 'Animations');

// ── Config ──────────────────────────────────────────────────────────
const CHARACTER_ID = '721c276f-a08a-406a-bcf0-6a9e3c607770';
const PAGE_LIMIT = 96;
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 60; // 2 min max wait per animation
const DELAY_BETWEEN_DOWNLOADS_MS = 500;
// ────────────────────────────────────────────────────────────────────

const headers = (bearer) => ({
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${bearer}`,
  'X-Api-Key': 'mixamo2'
});

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]+/g, '_').replace(/\s+/g, ' ').trim();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── API calls ───────────────────────────────────────────────────────

async function getAnimationList(bearer, page) {
  const url = `https://www.mixamo.com/api/v1/products?page=${page}&limit=${PAGE_LIMIT}&order=&type=Motion%2CMotionPack&query=`;
  const res = await fetch(url, { headers: headers(bearer) });
  if (!res.ok) throw new Error(`Animation list failed: ${res.status} ${res.statusText}`);
  return res.json();
}

async function getProduct(bearer, animId, characterId) {
  const url = `https://www.mixamo.com/api/v1/products/${animId}?similar=0&character_id=${characterId}`;
  const res = await fetch(url, { headers: headers(bearer) });
  if (!res.ok) throw new Error(`Product details failed: ${res.status} ${res.statusText}`);
  return res.json();
}

async function exportAnimation(bearer, characterId, gmsHashArray, productName) {
  const url = 'https://www.mixamo.com/api/v1/animations/export';
  const body = {
    character_id: characterId,
    gms_hash: gmsHashArray,
    preferences: { format: 'fbx7', skin: 'false', fps: '30', reducekf: '0' },
    product_name: productName,
    type: 'Motion'
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers(bearer), 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Export request failed: ${res.status} ${res.statusText}`);
  return res.json();
}

async function monitorExport(bearer, characterId) {
  const url = `https://www.mixamo.com/api/v1/characters/${characterId}/monitor`;

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const res = await fetch(url, { headers: headers(bearer) });

    if (res.status === 404) {
      throw new Error(`Monitor 404: animation not found`);
    }
    if (!res.ok && res.status !== 202) {
      throw new Error(`Monitor failed: ${res.status}`);
    }

    const data = await res.json();

    if (data.status === 'completed') {
      return data.job_result; // download URL
    }
    if (data.status === 'failed') {
      throw new Error(`Export failed: ${data.message || 'unknown error'}`);
    }

    // still processing
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('Export timed out');
}

async function downloadFile(url, filepath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(filepath, buffer);
  return buffer.length;
}

// ── Main logic ──────────────────────────────────────────────────────

async function downloadSingleAnimation(bearer, animId, characterId, productName, index, total) {
  const prefix = `[${index}/${total}]`;

  // Skip packs
  if (productName.includes(',')) {
    console.log(`${prefix} SKIP (pack): ${productName}`);
    return 'skipped';
  }

  const filename = sanitizeFilename(productName) + '.fbx';
  const filepath = path.join(ANIMATIONS_DIR, filename);

  // Skip if already downloaded
  if (fs.existsSync(filepath)) {
    console.log(`${prefix} EXISTS: ${filename}`);
    return 'exists';
  }

  console.log(`${prefix} Exporting: ${productName}...`);

  // Get product details (gms_hash)
  const product = await getProduct(bearer, animId, characterId);
  const gmsHash = product.details.gms_hash;
  const pvals = gmsHash.params.map(p => p[1]).join(',');
  const processedHash = { ...gmsHash, params: pvals };

  // Request export
  await exportAnimation(bearer, characterId, [processedHash], productName);

  // Poll until ready
  const downloadUrl = await monitorExport(bearer, characterId);

  // Download file
  const bytes = await downloadFile(downloadUrl, filepath);
  const sizeMB = (bytes / 1024 / 1024).toFixed(2);
  console.log(`${prefix} OK: ${filename} (${sizeMB} MB)`);

  return 'downloaded';
}

async function getAllAnimations(bearer) {
  console.log('Fetching animation list...');
  const allAnims = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const data = await getAnimationList(bearer, page);
    totalPages = data.pagination.num_pages;
    allAnims.push(...data.results);
    console.log(`  Page ${page}/${totalPages} - ${data.results.length} animations`);
    page++;
  }

  return allAnims;
}

async function main() {
  console.log('=== Mixamo Batch Downloader (FBX) ===\n');
  console.log(`Character ID: ${CHARACTER_ID}`);
  console.log(`Output dir:   ${ANIMATIONS_DIR}\n`);

  // Get bearer token
  let bearer = process.argv[2];
  if (!bearer) {
    console.log('To get your token:');
    console.log('  1. Log in to mixamo.com');
    console.log('  2. Open DevTools (F12) > Console');
    console.log('  3. Type:  localStorage.access_token');
    console.log('  4. Copy the result (without quotes)\n');
    bearer = await prompt('Paste token: ');
  }

  if (!bearer) {
    console.error('No token provided. Exiting.');
    process.exit(1);
  }

  // Remove quotes if user copied them
  bearer = bearer.replace(/^["']|["']$/g, '');

  // Ensure output dir exists
  if (!fs.existsSync(ANIMATIONS_DIR)) {
    fs.mkdirSync(ANIMATIONS_DIR, { recursive: true });
  }

  // Fetch full list
  const anims = await getAllAnimations(bearer);
  console.log(`\nFound ${anims.length} animations. Starting download...\n`);

  const stats = { downloaded: 0, skipped: 0, exists: 0, failed: 0 };

  for (let i = 0; i < anims.length; i++) {
    const anim = anims[i];
    try {
      const result = await downloadSingleAnimation(
        bearer, anim.id, CHARACTER_ID, anim.description, i + 1, anims.length
      );
      stats[result]++;
    } catch (err) {
      stats.failed++;
      console.error(`[${i + 1}/${anims.length}] ERROR: ${anim.description} — ${err.message}`);
    }
    await sleep(DELAY_BETWEEN_DOWNLOADS_MS);
  }

  console.log('\n=== DONE ===');
  console.log(`Downloaded: ${stats.downloaded}`);
  console.log(`Skipped:    ${stats.skipped} (packs)`);
  console.log(`Existing:   ${stats.exists}`);
  console.log(`Errors:     ${stats.failed}`);
  console.log(`\nFiles saved to: ${ANIMATIONS_DIR}`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
