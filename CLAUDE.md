# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common commands

- `node --test test/` — run all unit tests (node:test + assert/strict, no dependencies)
- `node --test --test-name-pattern="visualRect" test/` — run a single test by name fragment
- `node scripts/make-icons.js` — regenerate icons (zero-dependency PNG generator)
- `python3 -m http.server 8000` then open `http://localhost:8000/test/fixtures/long-page.html` — manual test page; `#tall` enables oversized mode (triggers multi-part splitting)

No build step. After changing code you MUST click reload at `chrome://extensions` manually (Chrome 137+ removed the `--load-extension` CLI flag, so CLI auto-loading is impossible).

## Architecture

MV3 extension, plain JS. Permissions are only `activeTab` + `scripting` (no host_permissions → zero install warnings) — this is a hard constraint; do not introduce APIs that require extra permissions.

**Data flow**: toolbar click → `background.js` (ESM service worker) bootstraps the content module graph via `chrome.scripting.executeScript({ func: () => import(chrome.runtime.getURL('content/main.js')) })` (executeScript awaits the import promise, so the listener is registered before `MSG.START` is sent; repeated clicks are guarded by ping/pong + ESM evaluate-once) → `SelectionOverlay` → `CaptureSession` (the content side scrolls the page, sends `MSG.CAPTURE` per frame so background calls `chrome.tabs.captureVisibleTab`, and decodes/draws the returned dataUrl into canvases) → `ResultOverlay` (download PNG / copy to clipboard).

**Key invariants** (the parts that require reading multiple files to understand):

- `content/geometry.js` is the pure-function core for all geometry and the fixed/sticky visibility rules (pure ESM, no DOM/Chrome dependencies) and the only unit-test target. Any purifiable logic belongs here, with a failing test first (TDD).
- **Capture coordinate system**: all stitch geometry treats `startY` (the selection's top edge in content coordinates) as 0; `planFrames`/`splitIntoParts`/`framePartIntersection` are offset-agnostic, and scrolling translates back via `setTop(frame + startY)`. 「截取整页」 = a selection carrying `fromTop: true`, startY = 0.
- **captureVisibleTab is rate-limited to 2/sec**: frame spacing ≥520ms with backoff retries, compatible with the 300ms per-frame lazy-load wait.
- **fixed/sticky handling is the subtlest part of this project** (full rules in spec §5.3 — read it before changing anything): WYSIWYG — elements covered by the selection (`coveredBySelection`, judged with the visual rect at collection time) appear once in frame 0; an unstuck sticky appears once at its natural position (`stickyAtNaturalPosition` + measuring `naturalTop` via the relative trick); stickies taller than half the viewport are scroll-jacking content and are never hidden (`stickyIsContent`); zero-area elements use the bounding box of visible descendants (`visualRect`, the GitHub blob toolbar pattern). Capture starts with a full warm-up scroll pass to trigger lazy loading, and every frame does a popup sweep (newly appeared fixed elements are hidden for the whole capture). The per-frame decision is pure `geometry.frameVisibility`; the DOM lifecycle is `content/fixed-elements.js`'s `FixedElementManager`.
- Stitched height × dpr beyond 16384px splits into multiple PNGs along frame boundaries; dpr is measured from the first frame (`img.width / innerWidth`), never trusted from `window.devicePixelRatio`.
- Selection/preview UI extends the `Overlay` base class in `content/overlay.js` (shadow DOM; styles from `overlay.css` injected via `web_accessible_resources`, `:host { all: initial }` isolation).

## Conventions

- Comments and documentation are in English; product UI strings live in `_locales` (en is `default_locale`; zh_TW mirrors zh_CN) and are referenced via `chrome.i18n.getMessage` / `__MSG_*__`.
- The spec is a living document: `docs/superpowers/specs/2026-10-21-fullpage-shot-design.md`. Amend the relevant section whenever behavior changes.
- Commit messages use English with a conventional prefix (`fix:` / `feat:` / `style:` etc.).
- Established tool for diagnosing real-site issues: the headless-CDP probes in `test/probe/` (`cdp.mjs` is the shared harness). They serve the repo over HTTP, dynamic-import the modules into a live page with `chrome.*` stubbed, and drive them directly — e.g. `node test/probe/capture-e2e.mjs` runs a full capture headlessly (frames bridged to `Page.captureScreenshot`). Set `CHROME_BIN` if the binary is not `google-chrome`.
