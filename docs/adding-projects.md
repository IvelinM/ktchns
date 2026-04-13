# Adding New Projects

This guide explains how to add new kitchen projects to the site. The build pipeline handles image optimisation and code generation automatically.

---

## Quick start

1. Create a folder under `assets/images/projects/` — the folder name becomes the project's display name on the site.
2. Drop your original JPG or PNG photos into that folder.
3. Run `npm run optimize` to convert them to WebP locally.
4. Commit the generated `.webp` files.
5. Run `npm run build` (or `npm start`) — the project list regenerates automatically from the committed WebPs.

**Example:**

```
assets/
  images/
    projects/
      Alla/          ← existing project
      Raychev/       ← existing project
      MyNewProject/  ← new folder you created
        photo1.jpg
        photo2.jpg
        photo3.JPG
```

After the next build, "MyNewProject" will appear in the Projects section with all its photos.

---

## What happens automatically

`scripts/generate-projects.js` runs before every `npm run build` or `npm start` and regenerates the project list from whatever `.webp` files are present. Image optimisation is **not** automatic — you run it manually once per batch of new photos and commit the results.

### `scripts/optimize-images.js` — image optimisation (manual)

Run once locally after adding new photos:

```bash
npm run optimize
```

- Deletes all existing `.webp` files inside every project folder (ensures a clean slate).
- Converts every `.jpg` / `.jpeg` / `.png` file to `.webp`:
  - Applies EXIF orientation so portrait photos stay portrait (critical for phone camera shots).
  - Resizes so neither width nor height exceeds **1920 px** while preserving the original aspect ratio. Images smaller than 1920 px are never enlarged.
  - Compresses at **quality 82** — typically a ~90–95 % file size reduction versus the original JPG.
- Original files are left untouched.
- **Commit the `.webp` files** after running this — CI has no access to the originals.

### `scripts/generate-projects.js` — code generation (automatic)

- Scans every subfolder in `assets/images/projects/`.
- Reads only the `.webp` files produced by step 1.
- Writes `src/app/projects/projects.data.ts` automatically — **do not edit that file by hand**.
- The folder name is used as both the project `id` and its display `name`.
- The first image in each folder becomes the cover thumbnail.
- Up to 6 hero images are chosen (one per project, round-robin) for the landing-page slider.

---

## Manual commands

```bash
# Convert JPG/PNG → WebP (run this locally after adding photos, then commit the .webp files)
npm run optimize

# Regenerate projects.data.ts without a full build
npm run generate
```

---

## Folder naming

| Convention | Result |
|---|---|
| `assets/images/projects/Sergey/` | Project name: **Sergey** |
| `assets/images/projects/Modern Kitchen/` | Project name: **Modern Kitchen** |
| `assets/images/projects/project-01/` | Project name: **project-01** |

The folder name appears exactly as written in the UI, so capitalise and space it the way you want it displayed.

---

## Removing a project

Delete the folder (and its contents) from `assets/images/projects/`, then run `npm run build`. The project disappears from the site automatically.

---

## Notes

- Supported source formats: `.jpg`, `.jpeg`, `.png` (case-insensitive).
- Output is always `.webp` — the slider components only read `.webp` files.
- Image order within a project follows alphabetical file name order, so rename files (`01_kitchen.jpg`, `02_detail.jpg`, …) if a specific sequence matters.
- The generated file `src/app/projects/projects.data.ts` is committed to the repo as part of the build output, but it will be overwritten on every build — never edit it manually.
