const fs   = require('fs');
const path = require('path');

const PAGE_LIMIT        = 96;
const POLL_INTERVAL_MS  = 500;
const MAX_POLL_ATTEMPTS = 60;
const DELAY_BETWEEN_MS  = 200;
const CACHE_FILE        = path.join(__dirname, '..', 'animations-cache.json');
const CACHE_MAX_AGE_MS  = 24 * 60 * 60 * 1000; // 24h
const LOG_FILE          = path.join(__dirname, '..', 'download.log');
const LIBRARY_SAVE_EVERY = 20; // save library every N updates

function writeLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* non-critical */ }
}

function makeHeaders(bearer) {
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${bearer}`,
    'X-Api-Key': 'mixamo2'
  };
}

function sanitize(name) {
  return name.replace(/[<>:"/\\|?*]+/g, '_').replace(/\s+/g, ' ').trim();
}

// Forward-slash relative path (portable across systems)
function rel(...parts) {
  return path.join(...parts).replace(/\\/g, '/');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── API calls ────────────────────────────────────────────────────────

async function getAnimationList(bearer, page) {
  const url = `https://www.mixamo.com/api/v1/products?page=${page}&limit=${PAGE_LIMIT}&order=&type=Motion%2CMotionPack&query=`;
  const res = await fetch(url, { headers: makeHeaders(bearer) });
  if (!res.ok) throw new Error(`List failed: ${res.status}`);
  return res.json();
}

async function getProduct(bearer, animId, characterId) {
  const url = `https://www.mixamo.com/api/v1/products/${animId}?similar=0&character_id=${characterId}`;
  const res = await fetch(url, { headers: makeHeaders(bearer) });
  if (!res.ok) throw new Error(`Product failed: ${res.status}`);
  return res.json();
}

async function exportAnim(bearer, characterId, gmsHashArray, productName) {
  const url = 'https://www.mixamo.com/api/v1/animations/export';
  const body = {
    character_id: characterId,
    gms_hash: gmsHashArray,
    preferences: { format: 'fbx7', skin: 'false', fps: '30', reducekf: '0' },
    product_name: productName,
    type: 'Motion'
  };
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...makeHeaders(bearer), 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify(body)
    });
    if (res.status === 429) { await sleep(attempt * 3000); continue; }
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    return res.json();
  }
  throw new Error('Export failed: 429 (rate limit, all retries exhausted)');
}

async function monitor(bearer, characterId) {
  const url = `https://www.mixamo.com/api/v1/characters/${characterId}/monitor`;
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    const res = await fetch(url, { headers: makeHeaders(bearer) });
    if (res.status === 404) throw new Error('Monitor 404');
    if (!res.ok && res.status !== 202) throw new Error(`Monitor ${res.status}`);
    const data = await res.json();
    if (data.status === 'completed') return data.job_result;
    if (data.status === 'failed') throw new Error(`Failed: ${data.message}`);
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('Timeout');
}

async function downloadFile(url, filepath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(filepath, buf);
  return buf.length;
}

// ── GIF download (non-blocking — failure doesn't stop FBX) ───────────

async function downloadGif(gifUrl, gifPath) {
  if (!gifUrl) return false;
  try {
    const res = await fetch(gifUrl);
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(gifPath, buf);
    return true;
  } catch {
    return false;
  }
}

// ── Cache ────────────────────────────────────────────────────────────

function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const { timestamp, anims } = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (Date.now() - timestamp > CACHE_MAX_AGE_MS) return null;
    return anims;
  } catch { return null; }
}

function saveCache(anims) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ timestamp: Date.now(), anims }));
  } catch { /* non-critical */ }
}

// ── Live Library ─────────────────────────────────────────────────────

function loadLibrary(libraryFile) {
  try {
    if (!fs.existsSync(libraryFile)) return {};
    const data = JSON.parse(fs.readFileSync(libraryFile, 'utf8'));
    // Support both old array format and new object format
    if (Array.isArray(data.animations)) {
      const obj = {};
      data.animations.forEach(e => { if (e.id) obj[e.id] = e; });
      return obj;
    }
    return data.animations || {};
  } catch { return {}; }
}

function saveLibrary(entries, libraryFile) {
  try {
    const animations = Object.values(entries).sort((a, b) => {
      // Sort: regular first (no pack), then by pack name, then by description
      if (!a.pack && b.pack) return -1;
      if (a.pack && !b.pack) return 1;
      if (a.pack !== b.pack) return (a.pack || '').localeCompare(b.pack || '');
      return (a.description || '').localeCompare(b.description || '');
    });

    const fbxCount  = animations.filter(e => e.fbx_downloaded).length;
    const gifCount  = animations.filter(e => e.gif_downloaded).length;
    const packCount = animations.filter(e => e.pack).length;

    const output = {
      summary: {
        generated_at:     new Date().toISOString(),
        total_animations: animations.length,
        from_packs:       packCount,
        fbx_downloaded:   fbxCount,
        gif_downloaded:   gifCount,
      },
      animations
    };
    fs.writeFileSync(libraryFile, JSON.stringify(output, null, 2), 'utf8');
  } catch { /* non-critical */ }
}

function upsertLibraryEntry(entries, entry) {
  entries[entry.id] = { ...(entries[entry.id] || {}), ...entry, updated_at: new Date().toISOString() };
}

// ── README generator ─────────────────────────────────────────────────

function getUniquePacks(allAnims) {
  const seen = new Set();
  return allAnims.filter(a => {
    if (a.type !== 'MotionPack' || !Array.isArray(a.motions)) return false;
    const key = a.name + '|' + a.motions.length;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function generateReadmeContent(allAnims, libraryEntries) {
  const uniquePacks  = getUniquePacks(allAnims);
  const regularAnims = allAnims.filter(a => a.type !== 'MotionPack');
  const animations   = Object.values(libraryEntries);

  const regularIdSet = new Set(regularAnims.map(a => a.id));
  let dupCount = 0, uniquePackCount = 0;
  for (const pack of uniquePacks) {
    for (const motion of pack.motions) {
      if (motion.product_id && regularIdSet.has(motion.product_id)) dupCount++;
      else uniquePackCount++;
    }
  }
  const packAnimCount   = uniquePacks.reduce((s, p) => s + p.motions.length, 0);
  const fbxCount        = animations.filter(e => e.fbx_downloaded).length;
  const gifCount        = animations.filter(e => e.gif_downloaded).length;
  const packCount       = animations.filter(e => e.pack).length;
  const standaloneCount = animations.length - packCount;
  const generatedAt     = new Date().toISOString();

  const packRows = uniquePacks.map(p => {
    const mc   = p.motions.length;
    const dups = p.motions.filter(m => m.product_id && regularIdSet.has(m.product_id)).length;
    return `| ${p.name.padEnd(38)} | ${String(mc).padStart(3)} | ${String(dups).padStart(3)} dup + ${String(mc - dups).padStart(3)} unique |`;
  }).sort();

  return `# Mixamo Animation Library

Generated: ${generatedAt}
Source: Mixamo (mixamo.com)

---

## Folder Structure

All paths below are relative to this file's location (the animations root folder).

\`\`\`
[this folder]/
│
├── LIBRARY_README.md           ← this file
├── animation-library.json      ← full machine-readable index
│
├── Animations/                 ← ${regularAnims.length} standalone animations
│   ├── Running.fbx
│   ├── Idle.fbx
│   └── ...
│
├── _Packs/                     ← ${uniquePacks.length} animation packs
│   ├── [Pack Name]/
│   │   ├── animation.fbx
│   │   └── ...
│   └── ...
│
└── _GIF/                       ← animated preview GIFs (mirror structure)
    ├── Running.gif
    ├── Idle.gif
    ├── ...
    └── _Packs/
        └── [Pack Name]/*.gif
\`\`\`

---

## Statistics

| Category                   | Count  |
|----------------------------|--------|
| Total animations           | ${String(animations.length).padStart(6)} |
| Standalone (root)          | ${String(standaloneCount).padStart(6)} |
| Pack animations            | ${String(packAnimCount).padStart(6)} |
| — duplicates of standalone | ${String(dupCount).padStart(6)} |
| — unique to packs only     | ${String(uniquePackCount).padStart(6)} |
| FBX files on disk          | ${String(fbxCount).padStart(6)} |
| GIF files on disk          | ${String(gifCount).padStart(6)} |

---

## Duplicate Animations Explained

**${dupCount} animations appear BOTH as standalone AND inside a pack.**

Mixamo packs are themed bundles — most of their content is a curated selection
of animations that also exist individually in the catalog.
They share the **same Mixamo product_id** — it is literally the same file.

### How duplicates are marked in animation-library.json

**Standalone entry** gets \`also_in_packs\`:
\`\`\`json
{
  "description": "Running",
  "pack": null,
  "also_in_packs": ["Male Locomotion Pack"],
  "fbx_file": "Running.fbx"
}
\`\`\`

**Pack entry** gets \`standalone_duplicate\`:
\`\`\`json
{
  "name": "running",
  "pack": "Male Locomotion Pack",
  "standalone_duplicate": {
    "id": "...",
    "description": "Running",
    "fbx_file": "Running.fbx",
    "gif_file": "_GIF/Running.gif"
  }
}
\`\`\`

**${uniquePackCount} animations are unique to their pack** — they do not exist as standalone.

---

## animation-library.json Fields

| Field                  | Type        | Description |
|------------------------|-------------|-------------|
| \`id\`                   | string      | Mixamo product UUID (primary key) |
| \`motion_id\`            | string      | Mixamo motion UUID |
| \`source\`               | string      | Always \`"mixamo"\` |
| \`type\`                 | string      | Always \`"Motion"\` |
| \`name\`                 | string      | Short display name |
| \`description\`          | string      | Full name used as filename |
| \`character_type\`       | string      | Rig type, e.g. \`"human"\` |
| \`pack\`                 | string/null | Pack name, or \`null\` for standalone |
| \`pack_description\`     | string/null | All motion names in the pack, comma-separated |
| \`fbx_file\`             | string      | Relative path to .fbx from this file |
| \`gif_file\`             | string      | Relative path to .gif preview from this file |
| \`fbx_downloaded\`       | boolean     | \`true\` if .fbx exists on disk |
| \`gif_downloaded\`       | boolean     | \`true\` if .gif exists on disk |
| \`also_in_packs\`        | string[]    | *(standalone only)* pack names that include this animation |
| \`standalone_duplicate\` | object/null | *(pack only)* reference to standalone version if exists |
| \`fps\`                  | number/null | Frames per second (from API enrichment) |
| \`loop\`                 | bool/null   | Loops? (from API enrichment) |
| \`thumbnail\`            | string      | CDN URL to static PNG preview |
| \`thumbnail_animated\`   | string      | CDN URL to animated GIF preview |
| \`updated_at\`           | string      | ISO 8601 timestamp |

---

## Packs

| Pack Name                              | Motions | Content |
|----------------------------------------|---------|---------|
${packRows.join('\n')}

---

## Using This Library

### Load all standalone animations
\`\`\`js
const lib = JSON.parse(fs.readFileSync('animation-library.json'));
const standalone = lib.animations.filter(a => !a.pack && a.fbx_downloaded);
\`\`\`

### Find animations from a specific pack
\`\`\`js
const pack = lib.animations.filter(a => a.pack === 'Breakdance Pack');
\`\`\`

### Avoid loading duplicate files
\`\`\`js
const unique = lib.animations.filter(a => !a.pack || !a.standalone_duplicate);
\`\`\`
`;
}

function saveReadme(allAnims, libraryEntries, outputDir) {
  try {
    const content = generateReadmeContent(allAnims, libraryEntries);
    fs.writeFileSync(path.join(outputDir, 'LIBRARY_README.md'), content, 'utf8');
  } catch { /* non-critical */ }
}

// ── Pack map builder ─────────────────────────────────────────────────
// Returns:
//   regularSet — Set of filenames for standalone (non-pack) animations
//   packMap    — Map<filename, packName> for files in EXACTLY one pack only

function buildPackMap(allAnims) {
  const regularSet = new Set();
  const claims = {}; // filename -> [packName, ...]
  const seenPacks = new Set();

  for (const anim of allAnims) {
    if (anim.type === 'MotionPack' && Array.isArray(anim.motions) && anim.motions.length > 0) {
      const key = anim.name + '|' + anim.motions.length;
      if (seenPacks.has(key)) continue;
      seenPacks.add(key);
      for (const motion of anim.motions) {
        const fn = sanitize(motion.name) + '.fbx';
        if (!claims[fn]) claims[fn] = [];
        claims[fn].push(sanitize(anim.name));
      }
    } else {
      regularSet.add(sanitize(anim.description) + '.fbx');
    }
  }

  const packMap = {};
  for (const [fn, packs] of Object.entries(claims)) {
    if (packs.length === 1 && !regularSet.has(fn)) packMap[fn] = packs[0];
  }
  return { regularSet, packMap };
}

// ── Auto-reorganize flat folder ───────────────────────────────────────

function autoReorganize(outputDir, packMap, onProgress) {
  if (!fs.existsSync(outputDir)) return;
  const files    = fs.readdirSync(outputDir).filter(f => f.endsWith('.fbx'));
  const animDir  = path.join(outputDir, 'Animations');
  let movedPacks = 0, movedAnims = 0;

  for (const file of files) {
    const fromPath = path.join(outputDir, file);
    const packName = packMap[file];

    if (packName) {
      // Move to _Packs/{pack}/
      const toDir  = path.join(outputDir, '_Packs', packName);
      const toPath = path.join(toDir, file);
      try {
        if (!fs.existsSync(toDir)) fs.mkdirSync(toDir, { recursive: true });
        if (fs.existsSync(toPath)) fs.unlinkSync(fromPath);
        else fs.renameSync(fromPath, toPath);
        movedPacks++;
      } catch (err) { writeLog(`REORGANIZE ERR (pack): "${file}" — ${err.message}`); }
    } else {
      // Move regular animation to Animations/
      const toPath = path.join(animDir, file);
      try {
        if (!fs.existsSync(animDir)) fs.mkdirSync(animDir, { recursive: true });
        if (fs.existsSync(toPath)) fs.unlinkSync(fromPath);
        else fs.renameSync(fromPath, toPath);
        movedAnims++;
      } catch (err) { writeLog(`REORGANIZE ERR (anim): "${file}" — ${err.message}`); }
    }
  }

  if (movedPacks > 0 || movedAnims > 0) {
    const msg = `Auto-reorganize: ${movedAnims} files → Animations/, ${movedPacks} pack files → _Packs/.`;
    writeLog(msg);
    onProgress?.({ type: 'log', message: msg });
  }
}

// ── Pack handler ─────────────────────────────────────────────────────

async function downloadPack(bearer, characterId, anim, index, total, outputDir, gifDir, packMap, libraryEntries, onProgress, rigBones) {
  const packDesc = anim.description;
  const result   = { downloaded: 0, exists: 0, failed: 0 };

  const product = await getProduct(bearer, anim.id, characterId);
  const details = product.details;

  if (details.motions && Array.isArray(details.motions) && details.motions.length > 0) {
    const packLabel   = sanitize(product.name || packDesc.substring(0, 40));
    const packFbxDir  = path.join(outputDir, '_Packs', packLabel);
    const packGifDir  = path.join(gifDir,    '_Packs', packLabel);
    if (!fs.existsSync(packFbxDir)) fs.mkdirSync(packFbxDir, { recursive: true });
    if (!fs.existsSync(packGifDir)) fs.mkdirSync(packGifDir, { recursive: true });

    onProgress?.({ type: 'log', message: `[${index}/${total}] Pack "${packLabel}" — ${details.motions.length} animations` });
    writeLog(`PACK [${index}/${total}] "${packLabel}" — ${details.motions.length} animations`);

    // Pack-level thumbnail as fallback for individual motions
    const packThumb    = product.thumbnail            || anim.thumbnail            || null;
    const packThumbGif = product.thumbnail_animated   || anim.thumbnail_animated   || null;

    // Build map: motionName -> product_id (from cache, for individual thumbnails)
    const motionProductIds = {};
    if (Array.isArray(anim.motions)) {
      anim.motions.forEach(m => { if (m.product_id) motionProductIds[m.name] = m.product_id; });
    }

    for (const motion of details.motions) {
      const motionName = motion.name;
      const filename   = sanitize(motionName) + '.fbx';
      const gifName    = sanitize(motionName) + '.gif';
      const fbxPath    = path.join(packFbxDir, filename);
      const gifPath    = path.join(packGifDir, gifName);

      // Check flat folder — move if unambiguously ours
      const flatPath = path.join(outputDir, filename);
      if (!fs.existsSync(fbxPath) && fs.existsSync(flatPath) && packMap[filename] === packLabel) {
        try { fs.renameSync(flatPath, fbxPath); writeLog(`MOVED "${filename}" → _Packs/${packLabel}/`); } catch { /* will re-download */ }
      }

      const fbxExists = fs.existsSync(fbxPath);
      const gifExists = fs.existsSync(gifPath);

      // Get individual GIF URL — fetch product thumbnail if we have product_id
      async function getMotionGifUrl() {
        const pid = motionProductIds[motionName];
        if (pid) {
          try {
            const mp = await getProduct(bearer, pid, characterId);
            return mp.thumbnail_animated || mp.thumbnail || packThumbGif;
          } catch { /* fall back to pack thumbnail */ }
        }
        return packThumbGif;
      }

      if (fbxExists) {
        result.exists++;
        onProgress?.({ type: 'exists', index, total, name: `${packLabel}/${filename}` });

        // Download individual GIF if missing
        if (!gifExists) {
          const gifUrl = await getMotionGifUrl();
          if (gifUrl) await downloadGif(gifUrl, gifPath);
        }

        // Update library entry
        const _existsId = motion.product_id || `${anim.id}_${sanitize(motionName)}`;
        upsertLibraryEntry(libraryEntries, {
          id:                 _existsId,
          motion_id:          motion.motion_id  || null,
          source:             'mixamo',
          type:               'Motion',
          name:               motionName,
          description:        motionName,
          character_type:     anim.character_type || 'human',
          pack:               product.name || anim.name,
          pack_description:   anim.description || null,
          fbx_file:           rel('_Packs', packLabel, filename),
          gif_file:           rel('_GIF', '_Packs', packLabel, gifName),
          fbx_downloaded:     true,
          gif_downloaded:     fs.existsSync(gifPath),
          thumbnail:          packThumb,
          thumbnail_animated: packThumbGif,
          ...(!libraryEntries[_existsId]?.rig_bones ? { rig_bones: rigBones, character_id: characterId } : {}),
        });
        continue;
      }

      try {
        const gms   = motion.gms_hash;
        const pvals = Array.isArray(gms.params) ? gms.params.map(p => p[1]).join(',') : gms.params;

        onProgress?.({ type: 'exporting', index, total, name: `${motionName} (${packLabel})` });
        await exportAnim(bearer, characterId, [{ ...gms, params: pvals }], motionName);

        onProgress?.({ type: 'downloading', index, total, name: motionName });
        const dlUrl = await monitor(bearer, characterId);
        const bytes = await downloadFile(dlUrl, fbxPath);

        // Fetch individual GIF URL, fall back to pack thumbnail
        const motionGifUrl = await getMotionGifUrl();
        const gifOk = motionGifUrl ? await downloadGif(motionGifUrl, gifPath) : false;

        result.downloaded++;
        writeLog(`OK [${index}/${total}] pack_motion ${(bytes/1024/1024).toFixed(2)}MB "_Packs/${packLabel}/${filename}"`);
        onProgress?.({ type: 'done', index, total, name: `${packLabel}/${filename}`, bytes });

        upsertLibraryEntry(libraryEntries, {
          id:                 motion.product_id || `${anim.id}_${sanitize(motionName)}`,
          motion_id:          motion.motion_id  || null,
          source:             'mixamo',
          type:               'Motion',
          name:               motionName,
          description:        motionName,
          character_type:     anim.character_type || 'human',
          pack:               product.name || anim.name,
          pack_description:   anim.description || null,
          fbx_file:           rel('_Packs', packLabel, filename),
          gif_file:           rel('_GIF', '_Packs', packLabel, gifName),
          fbx_downloaded:     true,
          gif_downloaded:     gifOk,
          thumbnail:          packThumb,
          thumbnail_animated: packThumbGif,
          rig_bones:          rigBones,
          character_id:       characterId,
        });

        await sleep(DELAY_BETWEEN_MS);
      } catch (err) {
        result.failed++;
        writeLog(`ERR [${index}/${total}] pack_motion "${motionName}" — ${err.message}`);
        onProgress?.({ type: 'error', index, total, name: motionName, error: err.message });
      }
    }

  } else if (details.gms_hash) {
    // Single animation with comma in name — goes to Animations/
    const animDir   = path.join(outputDir, 'Animations');
    const filename  = sanitize(packDesc) + '.fbx';
    const gifName   = sanitize(packDesc) + '.gif';
    const fbxPath   = path.join(animDir, filename);
    const gifPath   = path.join(gifDir,  gifName);
    const thumbGif  = anim.thumbnail_animated || null;

    if (!fs.existsSync(animDir)) fs.mkdirSync(animDir, { recursive: true });

    if (fs.existsSync(fbxPath)) {
      result.exists++;
      onProgress?.({ type: 'exists', index, total, name: filename });
      if (!fs.existsSync(gifPath) && thumbGif) await downloadGif(thumbGif, gifPath);

      upsertLibraryEntry(libraryEntries, {
        id: anim.id, motion_id: anim.motion_id, source: 'mixamo', type: anim.type,
        name: anim.name, description: packDesc, character_type: anim.character_type,
        pack: null, pack_description: null,
        fbx_file: rel('Animations', filename), gif_file: rel('_GIF', gifName),
        fbx_downloaded: true, gif_downloaded: fs.existsSync(gifPath),
        thumbnail: anim.thumbnail, thumbnail_animated: thumbGif,
        ...(!libraryEntries[anim.id]?.rig_bones ? { rig_bones: rigBones, character_id: characterId } : {}),
      });
    } else {
      const gms   = details.gms_hash;
      const pvals = Array.isArray(gms.params) ? gms.params.map(p => p[1]).join(',') : gms.params;
      onProgress?.({ type: 'exporting', index, total, name: packDesc });
      await exportAnim(bearer, characterId, [{ ...gms, params: pvals }], packDesc);
      onProgress?.({ type: 'downloading', index, total, name: packDesc });
      const dlUrl = await monitor(bearer, characterId);
      const bytes = await downloadFile(dlUrl, fbxPath);
      const gifOk = thumbGif ? await downloadGif(thumbGif, gifPath) : false;

      result.downloaded++;
      writeLog(`OK [${index}/${total}] ${(bytes/1024/1024).toFixed(2)}MB "Animations/${filename}"`);
      onProgress?.({ type: 'done', index, total, name: filename, bytes });

      upsertLibraryEntry(libraryEntries, {
        id: anim.id, motion_id: anim.motion_id, source: 'mixamo', type: anim.type,
        name: anim.name, description: packDesc, character_type: anim.character_type,
        pack: null, pack_description: null,
        fbx_file: rel('Animations', filename), gif_file: rel('_GIF', gifName),
        fbx_downloaded: true, gif_downloaded: gifOk,
        thumbnail: anim.thumbnail, thumbnail_animated: thumbGif,
        rig_bones: rigBones, character_id: characterId,
      });
      await sleep(DELAY_BETWEEN_MS);
    }
  } else {
    throw new Error('No motions/gms_hash found in pack');
  }

  return result;
}

// ── Main download loop ────────────────────────────────────────────────

/**
 * Downloads all Mixamo animations for a character.
 * @param {Object} opts
 * @param {string} opts.bearer
 * @param {string} opts.characterId
 * @param {string} opts.outputDir       — folder for FBX files
 * @param {string} [opts.gifDir]        — folder for GIF files (default: Animations-GIF next to outputDir)
 * @param {AbortSignal} opts.abortSignal
 * @param {Function} opts.onProgress
 * @param {boolean} opts.forceRefresh
 * @param {number} [opts.rigBones]      — number of bones in the character rig (e.g. 65 = with fingers, 25 = no fingers)
 */
async function downloadAll({ bearer, characterId, outputDir, gifDir, abortSignal, onProgress, forceRefresh, rigBones }) {
  rigBones = rigBones || 65;
  // All output lives inside the user-chosen outputDir
  const resolvedGifDir = gifDir || path.join(outputDir, '_GIF');
  const libraryFile    = path.join(outputDir, 'animation-library.json');

  // Load animation list
  let allAnims = forceRefresh ? null : loadCache();
  if (allAnims) {
    onProgress?.({ type: 'log', message: `Using cached animation list (${allAnims.length} animations).` });
    onProgress?.({ type: 'list', page: 1, totalPages: 1, count: allAnims.length });
  } else {
    allAnims = [];
    let page = 1, totalPages = 1;
    while (page <= totalPages) {
      if (abortSignal?.aborted) break;
      const data = await getAnimationList(bearer, page);
      totalPages = data.pagination.num_pages;
      allAnims.push(...data.results);
      onProgress?.({ type: 'list', page, totalPages, count: allAnims.length });
      page++;
    }
    saveCache(allAnims);
  }

  // Ensure output dirs exist
  const animDir = path.join(outputDir, 'Animations');
  if (!fs.existsSync(outputDir))        fs.mkdirSync(outputDir,        { recursive: true });
  if (!fs.existsSync(animDir))          fs.mkdirSync(animDir,          { recursive: true });
  if (!fs.existsSync(resolvedGifDir))   fs.mkdirSync(resolvedGifDir,   { recursive: true });

  // Build pack map + auto-reorganize existing flat FBX files
  const { packMap } = buildPackMap(allAnims);
  autoReorganize(outputDir, packMap, onProgress);

  // Load existing library (incremental updates)
  const libraryEntries = loadLibrary(libraryFile);
  let libDirtyCount = 0;

  const stats = { downloaded: 0, skipped: 0, exists: 0, failed: 0 };
  const total  = allAnims.length;

  for (let i = 0; i < total; i++) {
    if (abortSignal?.aborted) {
      onProgress?.({ type: 'aborted', index: i + 1, total });
      break;
    }

    const anim   = allAnims[i];
    const name   = anim.description;
    const isPack = anim.type === 'MotionPack' || name.includes(',');

    try {
      if (isPack) {
        const packResult = await downloadPack(
          bearer, characterId, anim, i + 1, total,
          outputDir, resolvedGifDir, packMap, libraryEntries, onProgress, rigBones
        );
        stats.downloaded += packResult.downloaded;
        stats.exists     += packResult.exists;
        stats.failed     += packResult.failed;
        onProgress?.({ type: 'statsUpdate', stats: { ...stats } });

        libDirtyCount++;
        if (libDirtyCount % LIBRARY_SAVE_EVERY === 0) saveLibrary(libraryEntries, libraryFile);
        continue;
      }

      // ── Regular animation ─────────────────────────────────────────
      const filename = sanitize(name) + '.fbx';
      const gifName  = sanitize(name) + '.gif';
      const fbxPath  = path.join(animDir,        filename);
      const gifPath  = path.join(resolvedGifDir, gifName);
      const thumbGif = anim.thumbnail_animated || null;

      if (fs.existsSync(fbxPath)) {
        stats.exists++;
        onProgress?.({ type: 'exists', index: i + 1, total, name: filename });

        // GIF might be missing
        if (!fs.existsSync(gifPath) && thumbGif) await downloadGif(thumbGif, gifPath);

        upsertLibraryEntry(libraryEntries, {
          id: anim.id, motion_id: anim.motion_id, source: 'mixamo', type: anim.type,
          name: anim.name, description: name, character_type: anim.character_type,
          pack: null, pack_description: null,
          fbx_file: rel('Animations', filename), gif_file: rel('_GIF', gifName),
          fbx_downloaded: true, gif_downloaded: fs.existsSync(gifPath),
          thumbnail: anim.thumbnail, thumbnail_animated: thumbGif,
          // Retroactively tag only if not already set (file existed before this feature)
          ...(!libraryEntries[anim.id]?.rig_bones ? { rig_bones: rigBones, character_id: characterId } : {}),
        });

        libDirtyCount++;
        if (libDirtyCount % LIBRARY_SAVE_EVERY === 0) saveLibrary(libraryEntries, libraryFile);
        continue;
      }

      onProgress?.({ type: 'exporting', index: i + 1, total, name });

      const product = await getProduct(bearer, anim.id, characterId);
      const gms     = product.details.gms_hash;
      const pvals   = gms.params.map(p => p[1]).join(',');
      await exportAnim(bearer, characterId, [{ ...gms, params: pvals }], name);

      onProgress?.({ type: 'downloading', index: i + 1, total, name });
      const dlUrl = await monitor(bearer, characterId);
      const bytes = await downloadFile(dlUrl, fbxPath);

      const gifOk = thumbGif ? await downloadGif(thumbGif, gifPath) : false;

      stats.downloaded++;
      writeLog(`OK [${i+1}/${total}] ${(bytes/1024/1024).toFixed(2)}MB "Animations/${filename}" gif:${gifOk}`);
      onProgress?.({ type: 'done', index: i + 1, total, name: filename, bytes });

      upsertLibraryEntry(libraryEntries, {
        id: anim.id, motion_id: anim.motion_id, source: 'mixamo', type: anim.type,
        name: anim.name, description: name, character_type: anim.character_type,
        pack: null, pack_description: null,
        fbx_file: rel('Animations', filename), gif_file: rel('_GIF', gifName),
        fbx_downloaded: true, gif_downloaded: gifOk,
        thumbnail: anim.thumbnail, thumbnail_animated: thumbGif,
        rig_bones: rigBones, character_id: characterId,
      });

      libDirtyCount++;
      if (libDirtyCount % LIBRARY_SAVE_EVERY === 0) saveLibrary(libraryEntries, libraryFile);

      await sleep(DELAY_BETWEEN_MS);
    } catch (err) {
      stats.failed++;
      writeLog(`ERR [${i+1}/${total}] "${name}" — ${err.message}`);
      onProgress?.({ type: 'error', index: i + 1, total, name, error: err.message });
      await sleep(1000);
    }
  }

  // Final library save + README
  saveLibrary(libraryEntries, libraryFile);
  saveReadme(allAnims, libraryEntries, outputDir);
  onProgress?.({ type: 'log', message: `Library saved: ${libraryFile}` });

  return stats;
}

// ── Re-download all GIFs ─────────────────────────────────────────────
// Force-overwrites pack GIFs with individual thumbnails.
// Regular GIFs are skipped if they already exist.

async function downloadAllGifs({ bearer, characterId, outputDir, abortSignal, onProgress, rigBones }) {
  rigBones = rigBones || 65;
  const gifDir      = path.join(outputDir, '_GIF');
  const libraryFile = path.join(outputDir, 'animation-library.json');

  const allAnims = loadCache();
  if (!allAnims) { throw new Error('No animation cache found. Run a full download first.'); }

  if (!fs.existsSync(gifDir)) fs.mkdirSync(gifDir, { recursive: true });

  const libraryEntries = loadLibrary(libraryFile);

  // Build thumbnail map from regular animations (id → thumbnail_animated)
  // Many pack motions ARE also regular animations — their thumbnails are in the cache!
  const thumbCache = {};
  allAnims.filter(a => a.type !== 'MotionPack' && a.thumbnail_animated)
    .forEach(a => { thumbCache[a.id] = a.thumbnail_animated; });

  // Deduplicate packs
  const seenPacks  = new Set();
  const uniquePacks = [];
  const regularAnims = [];
  for (const anim of allAnims) {
    if (anim.type === 'MotionPack' && Array.isArray(anim.motions) && anim.motions.length > 0) {
      const key = anim.name + '|' + anim.motions.length;
      if (!seenPacks.has(key)) { seenPacks.add(key); uniquePacks.push(anim); }
    } else {
      regularAnims.push(anim);
    }
  }

  const total = regularAnims.length + uniquePacks.reduce((s, p) => s + p.motions.length, 0);
  let done = 0, downloaded = 0, skipped = 0, failed = 0;

  function progress(name, isNew) {
    done++;
    if (isNew) downloaded++; else skipped++;
    onProgress?.({ type: 'gif-progress', done, total, downloaded, skipped, failed, name });
  }

  // ── Regular animations ─────────────────────────────────────────
  for (const anim of regularAnims) {
    if (abortSignal?.aborted) break;
    const baseName = sanitize(anim.description);
    const gifPath  = path.join(gifDir, baseName + '.gif');

    if (fs.existsSync(gifPath)) { progress(baseName, false); continue; }

    const ok = anim.thumbnail_animated ? await downloadGif(anim.thumbnail_animated, gifPath) : false;
    if (!ok) failed++;
    progress(baseName, ok);

    // Update library
    if (libraryEntries[anim.id]) {
      libraryEntries[anim.id].gif_downloaded = ok;
      libraryEntries[anim.id].gif_file = rel('_GIF', baseName + '.gif');
    }
  }

  // ── Pack motions — force individual thumbnails ──────────────────
  for (const pack of uniquePacks) {
    if (abortSignal?.aborted) break;
    const packLabel  = sanitize(pack.name);
    const packGifDir = path.join(gifDir, '_Packs', packLabel);
    if (!fs.existsSync(packGifDir)) fs.mkdirSync(packGifDir, { recursive: true });

    for (const motion of pack.motions) {
      if (abortSignal?.aborted) break;
      const baseName = sanitize(motion.name);
      const gifPath  = path.join(packGifDir, baseName + '.gif');
      const entryId  = motion.product_id || `${pack.motion_id}_${baseName}`;

      // Get individual GIF URL:
      // 1. From cache (if this motion is also a standalone product) — no API call needed
      // 2. From product API (if bearer available and not in cache)
      // 3. Fallback to pack thumbnail
      let gifUrl = thumbCache[motion.product_id] || null;

      if (!gifUrl && motion.product_id && bearer) {
        try {
          const mp = await getProduct(bearer, motion.product_id, characterId);
          gifUrl = mp.thumbnail_animated || mp.thumbnail || null;
          if (gifUrl) thumbCache[motion.product_id] = gifUrl; // cache for next time
          await sleep(30);
        } catch { /* ignore */ }
      }

      if (!gifUrl) gifUrl = pack.thumbnail_animated || null;

      const ok = gifUrl ? await downloadGif(gifUrl, gifPath) : false;
      if (!ok) failed++;
      progress(`${packLabel}/${baseName}`, ok);

      if (libraryEntries[entryId]) {
        libraryEntries[entryId].gif_downloaded = ok;
        libraryEntries[entryId].gif_file = rel('_GIF', '_Packs', packLabel, baseName + '.gif');
        if (gifUrl) libraryEntries[entryId].thumbnail_animated = gifUrl;
      }
    }
  }

  saveLibrary(libraryEntries, libraryFile);
  saveReadme(allAnims, libraryEntries, outputDir);
  return { downloaded, skipped, failed, total };
}

module.exports = { downloadAll, downloadAllGifs };
