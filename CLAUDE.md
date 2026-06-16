# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # ng serve — dev server at http://localhost:4200/ktchns/
npm run build      # production build to dist/ktchns/browser/
npm run watch      # build in watch mode (development config)
npm test           # run Karma/Jasmine unit tests (headless Chrome)
npm run lint       # ESLint via angular-eslint
npm run optimize   # convert assets/images/projects/**/*.{jpg,png} → .webp (manual)
npm run generate   # regenerate src/app/projects/projects.data.ts from the .webp files
```

Run a single spec file:
```bash
npx ng test --include='src/app/app.component.spec.ts'
```

**`generate` runs automatically** before `start` and `build` (npm `prestart`/`prebuild` hooks), so the project list is always fresh. **`optimize` is manual** — run it once after adding new source photos, then commit the resulting `.webp` files (CI never sees the originals).

## Architecture

Single-page Angular 19 standalone app (no NgModules). Entry: `src/main.ts` → `AppComponent` via `src/app/app.config.ts`. `app.routes.ts` is empty — there is no routing; everything is one scrolling page composed of standalone child components. `app.config.ts` enables zone change detection with `eventCoalescing` and `provideAnimationsAsync()`.

### Component composition
`AppComponent` (`src/app/app.component.*`) is the **shell**: toolbar/nav, section anchors, and the i18n source of truth. It imports and lays out the feature components:

- **`hero-slider`** — auto-rotating background slideshow driven by `HERO_IMAGES`.
- **`projects` / `projects/project-slider`** — project grid that opens a per-project image lightbox.
- **`particles-bg`** — tsParticles animated background.
- **`contact-form`** — see backend note below.
- **`loader`** — initial loading screen.
- **`model-hero`** — Three.js wireframe hero (loads `assets/3D/slav.glb`, boots **outside** Angular's zone via `NgZone.runOutsideAngular`, uses `OrbitControls` in dev and GSAP `ScrollTrigger` camera choreography in prod). **Currently dormant** — it is not imported by `AppComponent`; `hero-slider` is the active hero. Keep this in mind before assuming it renders.

### Internationalization
No i18n library. `AppComponent` holds a `translations` object keyed `'en' | 'bg'` (**default `'bg'`**); `currentLanguage` + `toggleLanguage()` switch it. Child components receive only the slice of strings they need via `@Input` (e.g. the `ContactTranslations` interface is passed into `contact-form`). When adding UI text, extend the `Translations` type and **both** language objects, then thread the strings down as inputs.

### Projects data pipeline (the key non-obvious system)
Project content is **folder-driven**, not hand-authored:

1. Images live in `assets/images/projects/<FolderName>/`. Folder name = project `id` **and** display name (rendered verbatim).
2. `scripts/optimize-images.js` (manual, `npm run optimize`) deletes all existing `.webp`, then converts `.jpg/.jpeg/.png` → `.webp` (EXIF-rotated, max 1920px, quality 82, never upscaled). Originals are left untouched and need not be committed.
3. `scripts/generate-projects.js` (auto pre-build) scans those folders, reads `.webp` files in alphabetical order, and **overwrites** `src/app/projects/projects.data.ts` with `PROJECTS` (first image = `cover`) and `HERO_IMAGES` (up to 6, one per project round-robin).

⚠️ **Never hand-edit `src/app/projects/projects.data.ts`** — it is regenerated on every build. To reorder images, rename source files (`01_...`, `02_...`). Full workflow in `docs/adding-projects.md`.

### Contact form backend
`contact-form.component.ts` POSTs the form as JSON to a Cloudflare Worker (`WORKER_URL` constant). There is no server-side code in this repo; the Worker is deployed separately.

## Deployment

Pushes to `main` trigger `.github/workflows/deploy-angular.yml`, which builds with `--configuration=production --base-href "/" --deploy-url "/"` and deploys `dist/ktchns/browser/` to the `gh-pages` branch.

The site is served from the custom domain **viaminima.design**, so `baseHref` is `/` (the `public/CNAME` file is copied into the build to tell GitHub Pages the domain). The dev server still serves under `/ktchns/` per `angular.json`.

> Note: `README.md` states the deploy uses `--base-href "/ktchns/"` — that is outdated. The workflow is the source of truth and uses `/`.

## Contact details & the phone-number guardrail

⚠️ **Only the business number `+359 2 4374685` (`tel:+35924374685`) may ever appear publicly** — on the site, in structured data (`index.html` JSON-LD), or in Google Ads. The owner's **personal mobile must never be exposed**: a personal-number Google Ads *call asset* once leaked it and caused misdirected calls. Never add a non-business phone number to the site, schema, or ads, and **never write a personal number into this repo** (it is **public** on GitHub) — keep such details in local Claude memory only.

The studio address (Sofia, Vitosha district) lives in `AppComponent`'s `translations.*.contactAddress` and the `index.html` JSON-LD `PostalAddress`.

## SEO

`index.html` is intentionally **Bulgarian-first**, targeting the primary keyword **"кухни по поръчка"** (`<html lang="bg">`, Bulgarian `<title>`/description/OG, a `HomeAndConstructionBusiness` JSON-LD block, and a `<noscript>` content fallback for non-JS crawlers). Do **not** revert the meta/title to English. This is a client-rendered SPA; the largest outstanding SEO lever is **prerendering (SSG)** — note that `particles-bg` runs tsParticles in `ngAfterViewInit`, which must be guarded before SSR/prerender will build.

## Marketing / ops

The site advertises via a Google Ads account (Via Minima). Two docs cover it:
- `docs/google-ads-automation.md` — **how** to analyse/fine-tune the account by driving a logged-in Chrome over CDP (`http://localhost:9222`) with the Playwright CLI or MCP, including UI-editing traps.
- `docs/google-ads-campaign-notes.md` — **what** the account state, diagnosis, and roadmap are.

That automation tooling lives **outside this repo** (`C:\Users\MATEV\ads-automation\`) and is machine-local. **Never make changes that affect ad spend without the user's explicit confirmation**, and prefer one supervised change at a time.
