# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # ng serve — dev server at http://localhost:4200/ktchns/
npm run build      # production build to dist/ktchns/browser/
npm run watch      # build in watch mode (development config)
npm test           # run Karma/Jasmine unit tests
npm run lint       # ESLint via angular-eslint
```

Run a single spec file:
```bash
npx ng test --include='src/app/app.component.spec.ts'
```

## Architecture

Single-page Angular 19 standalone app (no NgModules). Entry point: `src/main.ts` → bootstraps `AppComponent` via `src/app/app.config.ts`.

- **`AppComponent`** (`src/app/app.component.*`) — the only component. Contains all UI: toolbar, hero section, services grid, footer. No child routes are defined yet (`app.routes.ts` exports an empty array).
- **Translations** — handled inline in `AppComponent` via a `translations` object keyed by `'en'` | `'bg'`. `currentLanguage` drives the active language; toggled by `toggleLanguage()`.
- **Angular Material** — used for UI primitives (toolbar, buttons, icons). Theme: `cyan-orange` prebuilt. Animations provided async via `provideAnimationsAsync()`.
- **Styling** — global styles in `src/styles.scss`; component styles in `src/app/app.component.scss`.

## Deployment

Merges to `main` trigger GitHub Actions (`.github/workflows/deploy-angular.yml`), which builds with `--base-href "/ktchns/" --deploy-url "/ktchns/"` and deploys `dist/ktchns/browser/` to the `gh-pages` branch.

The `baseHref` in `angular.json` must remain `"/ktchns/"` (with leading and trailing slashes) to match the GitHub Pages sub-path. The `<base href="/">` in `src/index.html` is overridden at build time by the CLI.
