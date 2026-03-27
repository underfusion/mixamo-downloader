# Mixamo Downloader

An Electron desktop app for batch-downloading all your Mixamo animations (FBX) and animated GIF previews, with a built-in Mixamo browser for easy login.

![Mixamo Downloader](https://img.shields.io/badge/Electron-Desktop-blue) ![Node.js](https://img.shields.io/badge/Node.js-20%2B-green) ![Platform](https://img.shields.io/badge/Platform-Windows-lightgrey)

---

## Features

- **Embedded Mixamo browser** — log in directly inside the app, token is captured automatically
- **Batch FBX download** — downloads all animations for your character in FBX 7.0 / 30 FPS format
- **Animated GIF previews** — downloads the preview GIF for every animation (including per-animation previews for pack motions)
- **Pack support** — pack animations are organized into `_Packs/{Pack Name}/` subfolders automatically
- **Auto-reorganize** — if you have existing flat downloads, the app moves files into the correct folders on startup
- **Live animation library** — builds and updates `animation-library.json` during download with full metadata
- **Duplicate detection** — pack animations that are identical to standalone ones are cross-referenced in the library
- **README generation** — generates `LIBRARY_README.md` in your output folder describing the entire structure

---

## Output Structure

```
[your chosen folder]/
│
├── animation-library.json      ← full machine-readable index of all animations
├── LIBRARY_README.md           ← auto-generated documentation
│
├── Animations/                 ← standalone FBX files (~1800 animations)
│   ├── Running.fbx
│   ├── Idle.fbx
│   └── ...
│
├── _Packs/                     ← pack animations organized by pack name
│   ├── Male Locomotion Pack/
│   │   ├── running.fbx
│   │   └── ...
│   └── [other packs]/
│
└── _GIF/                       ← animated GIF previews (mirrors FBX structure)
    ├── Running.gif
    ├── Idle.gif
    ├── ...
    └── _Packs/
        └── [Pack Name]/*.gif
```

---

## Requirements

- [Node.js](https://nodejs.org/) 20+
- A [Mixamo](https://www.mixamo.com/) account (free)

---

## Installation

```bash
git clone https://github.com/underfusion/mixamo-downloader.git
cd mixamo-downloader
npm install
```

Or on Windows, double-click `install.bat`.

---

## Usage

```bash
npm start
```

Or double-click `start.bat`.

1. **Log in** — the app opens Mixamo in the left panel. Log in with your Adobe account. The status dot turns green when the token is detected.
2. **Select output folder** — click `...` next to the output field to choose where to save animations.
3. **Download** — click **Download all animations**. The app will fetch the animation list and download every FBX + GIF.
4. **Fix GIFs** — if you already have FBX files, click **Download / Fix GIFs** to (re-)download all GIF previews without touching the FBX files.

### Refresh animation list

Mixamo's animation list is cached locally for 24 hours. Click **Refresh animation list** to force a fresh fetch on the next download.

---

## CLI Tools

These scripts can be run independently from the command line:

### Generate / rebuild the animation library

```bash
node scripts/generate-library.mjs [output_dir]
# With API enrichment (fps, loop info):
set MIXAMO_TOKEN=<your_bearer_token> && node scripts/generate-library.mjs [output_dir]
```

### Download GIFs only

```bash
node scripts/download-gifs.mjs [output_dir]
# With pack GIFs (requires token):
set MIXAMO_TOKEN=<your_bearer_token> && node scripts/download-gifs.mjs [output_dir]
```

### Reorganize flat folder into packs

```bash
node scripts/reorganize.mjs            # dry-run — analysis only
node scripts/reorganize.mjs --move     # actually moves files
```

---

## animation-library.json

The library file is generated and updated automatically during download. It includes:

| Field | Description |
|---|---|
| `id` | Mixamo product UUID |
| `description` | Full animation name (used as filename) |
| `pack` | Pack name, or `null` for standalone |
| `fbx_file` | Relative path to the FBX file |
| `gif_file` | Relative path to the GIF preview |
| `fbx_downloaded` | `true` if the file exists on disk |
| `gif_downloaded` | `true` if the GIF exists on disk |
| `also_in_packs` | *(standalone only)* list of packs that contain this animation |
| `standalone_duplicate` | *(pack only)* reference to the standalone version if it exists |
| `thumbnail_animated` | CDN URL to the animated GIF preview |

### About duplicates

~600 out of ~745 pack animations are identical to standalone animations — same motion, same Mixamo `product_id`, just grouped into a themed pack. The library cross-references these so you can avoid loading duplicate files:

```js
// Load only unique animations (no pack duplicates)
const lib = JSON.parse(fs.readFileSync('animation-library.json'));
const unique = lib.animations.filter(a => !a.pack || !a.standalone_duplicate);
```

---

## Notes

- The app caches the animation list in `animations-cache.json` (next to the app, not in your output folder)
- Download speed is intentionally throttled to avoid hitting Mixamo's rate limits
- The `animations-cache.json`, `download.log`, and your `Animations/` folder are excluded from git

---

## License

MIT
