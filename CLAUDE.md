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

**Data flow**: toolbar click → `background.js` (service worker) injects 5 content scripts in a fixed order (stitch → select → capture → preview → main; repeated clicks reuse via the `window.__fpsMainLoaded` ping/pong guard) → selection overlay → capture loop (the content script scrolls the page, sends a message per frame so background calls `chrome.tabs.captureVisibleTab`, and decodes/draws the returned dataUrl on the content side) → stitched canvases → preview overlay (download PNG / copy to clipboard).

**Key invariants** (the parts that require reading multiple files to understand):

- `content/stitch.js` is the pure-function core for all geometry (UMD: `window.FpsStitch` in the browser, requireable in node) and the only unit-test target. Any purifiable logic belongs here, with a failing test first (TDD).
- **Capture coordinate system**: all stitch geometry treats `startY` (the selection's top edge in content coordinates) as 0; `planFrames`/`assignParts`/`frameSlice` are offset-agnostic, and scrolling translates back via `setTop(frame + startY)`. 「截取整页」 = a selection carrying `fromTop: true`, startY = 0.
- **captureVisibleTab is rate-limited to 2/sec**: frame spacing ≥520ms with backoff retries, compatible with the 300ms per-frame lazy-load wait.
- **fixed/sticky handling is the subtlest part of this project** (full rules in spec §5.3 — read it before changing anything): WYSIWYG — elements covered by the selection (`inSelection`, judged with the visual rect at collection time) appear once in frame 0; an unstuck sticky appears once at its natural position (`stickyVisible` + measuring `naturalTop` via the relative trick); stickies taller than half the viewport are scroll-jacking content and are never hidden (`stickyIsContent`); zero-area elements use the bounding box of visible descendants (`visualRect`, the GitHub blob toolbar pattern). Capture starts with a full warm-up scroll pass to trigger lazy loading, and every frame does a popup sweep (newly appeared fixed elements are hidden for the whole capture).
- Stitched height × dpr beyond 16384px splits into multiple PNGs along frame boundaries; dpr is measured from the first frame (`img.width / innerWidth`), never trusted from `window.devicePixelRatio`.
- Selection/preview UI lives in a Shadow DOM; styles come from `overlay.css` injected via `web_accessible_resources`, with `:host { all: initial }` isolation.

## Conventions

- Comments and documentation are in English; product UI strings (buttons, hints, error messages, badge text) stay Chinese.
- The spec is a living document: `docs/superpowers/specs/2026-10-21-fullpage-shot-design.md`. Amend the relevant section whenever behavior changes.
- Commit messages use Chinese with a conventional prefix (`fix:` / `feat:` / `style:` etc.).
- Established tool for diagnosing real-site issues: a headless Chrome CDP probe (`--headless=new --remote-debugging-port=9222` + a Node script using the built-in WebSocket). You can inject the `stitch.js`/`capture.js` sources into a live page and call `FpsCapture.collectFixedElements()` etc. directly to verify collection and visibility rules, saving frames with `Page.captureScreenshot` to inspect them visually.
