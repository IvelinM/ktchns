# KTCHNS — IM Studio

Angular 19 portfolio site for IM Studio, a custom kitchen furniture studio. Deployed to GitHub Pages.

---

## Development

```bash
npm start        # dev server at http://localhost:4200/ktchns/
npm run build    # production build → dist/ktchns/browser/
npm run watch    # build in watch mode (development config)
npm test         # Karma/Jasmine unit tests
npm run lint     # ESLint
```

---

## Adding a new project

Projects are driven entirely by the folder structure under `assets/images/projects/`. No code changes needed.

### Step 1 — create a folder and drop in your photos

```
assets/images/projects/
  Alla/           ← existing project
  Raychev/        ← existing project
  MyNewProject/   ← create this
    IMG_001.jpg
    IMG_002.jpg
    IMG_003.JPG
```

The folder name becomes the project's display name on the site exactly as written, so capitalise it the way you want it to appear.

### Step 2 — optimise the images

```bash
npm run optimize
```

This runs `scripts/optimize-images.js`, which:

- **Deletes** all existing `.webp` files in every project folder first (clean slate on every run).
- **Converts** every `.jpg` / `.jpeg` / `.png` to `.webp`:
  - Applies EXIF orientation — phone camera shots stay portrait, not sideways.
  - Resizes so neither dimension exceeds **1920 px**, preserving the original aspect ratio. Smaller images are never enlarged.
  - Compresses at **quality 82** — typically 90–95 % smaller than the original JPG.
- Leaves the original files untouched.

After the script finishes you'll see a log like:

```
[optimize] deleted 12 existing .webp file(s)
[optimize] MyNewProject/IMG_001.jpg  4032x3024 3812KB  →  1920x1440 98KB  (.webp)
[optimize] MyNewProject/IMG_002.jpg  3024x4032 4102KB  →  1440x1920 112KB  (.webp)
[optimize] done — 14 image(s) converted
```

### Step 3 — commit the .webp files

```bash
git add assets/images/projects/MyNewProject/
git commit -m "add MyNewProject images"
git push
```

The original JPGs do not need to be committed (they can be large). Only the `.webp` files need to be in the repo — CI has no access to the originals.

### Step 4 — build or push

- **Locally:** `npm start` or `npm run build` — the project list is regenerated automatically.
- **On push to `main`:** GitHub Actions builds and deploys to GitHub Pages. The project appears live within a minute.

---

## How the project list is generated

`scripts/generate-projects.js` runs automatically before every `npm start` and `npm run build` (via npm `prestart`/`prebuild` hooks). It:

- Scans every subfolder in `assets/images/projects/`.
- Reads only `.webp` files (alphabetical order within each folder).
- Writes `src/app/projects/projects.data.ts` with the full project list and the hero images for the landing-page slider.

**Do not edit `projects.data.ts` by hand** — it is overwritten on every build.

To control image order within a project, rename the source files before optimising:

```
01_overview.jpg
02_detail.jpg
03_closeup.jpg
```

---

## Removing a project

Delete the folder from `assets/images/projects/`, commit the deletion, and push. The project disappears from the site automatically on the next build.

---

## Image optimisation reference

| Setting | Value |
|---|---|
| Source formats | `.jpg`, `.jpeg`, `.png` (case-insensitive) |
| Output format | `.webp` |
| Max dimension | 1920 px (either axis) |
| Quality | 82 |
| EXIF orientation | Applied (portrait stays portrait) |
| Enlargement | Never |

Run manually at any time:

```bash
npm run optimize   # convert images only
npm run generate   # regenerate projects.data.ts only (no image conversion)
```

---

## Deployment

Merges to `main` trigger GitHub Actions (`.github/workflows/deploy-angular.yml`), which builds with `--base-href "/ktchns/"` and deploys `dist/ktchns/browser/` to the `gh-pages` branch.
