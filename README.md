# FullPage Shot

A Chrome extension (MV3, zero dependencies) that captures a full webpage by scrolling and stitching, with region selection to exclude sidebars and other irrelevant content.

The UI speaks English and Chinese, following the browser's language.

## Install

1. Get the code:
   - Clone: `git clone https://github.com/ianlynxk/fullpage-shot.git`
   - Or download: on the GitHub repo page, **Code → Download ZIP**, then extract the archive
2. Open `chrome://extensions` and enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the cloned/extracted `fullpage-shot` directory
4. The FullPage Shot icon appears in the toolbar — pin it via the puzzle icon for quick access

To update later: `git pull` (or download the ZIP again), then click the reload button on the extension card at `chrome://extensions`.

## Usage

1. Click the toolbar icon on the target page
2. Drag a rectangle around the content column to keep (leave sidebars outside the box), or click **Capture full page**
3. Enter / the action button → the page scrolls and stitches automatically (Esc cancels)
4. In the preview overlay: **Download PNG** or **Copy to clipboard**

## Behavior notes

- The selection's horizontal range becomes the fixed crop column; vertically the capture runs from the selection's top edge to the content end (Capture full page starts from the top)
- Inner scroll containers are auto-detected (nearest scrollable ancestor of the selection center with `scrollHeight > clientHeight`); before capturing, the page scrolls so the container is fully visible — containers taller than the viewport are rejected with a message suggesting Capture full page
- fixed / stuck sticky elements (e.g. navbars): if the selection covered them, they appear once at the top of the result as seen; otherwise they never appear and never occlude content. An unstuck sticky appears once at its natural position as normal content
- Stickies taller than half the viewport are treated as scroll-jacking content and are never hidden — they appear multiple times down the long image as scroll progresses, which is the inherent expression of scroll animation in a linear image
- Before capturing, the page is scrolled through once as a warm-up (badge shows "Warming up") to trigger lazy images/iframes and scroll reveal animations; fixed elements that pop up mid-capture (e.g. delayed cookie banners) are hidden automatically
- Stitched height beyond 16384px (× dpr) is split into multiple PNGs; clipboard copy produces a single image scaled down to fit
- Progress is shown on the extension icon badge (i/n)

## Known limitations

- Cannot inject into `chrome://` pages, the Chrome Web Store, or the built-in PDF viewer (icon shows "!")
- Lazy content relies on scroll-passing + a 300ms wait to wake up; extreme lazy-loading strategies may still miss images
- If the page keeps changing during capture (infinite scroll growth), the content height recorded at capture start is authoritative
- Content inside iframes does not participate in scroll-container detection (the screenshot itself still includes iframe pixels)

## Development

- `node --test test/`: unit tests for the geometry.js pure functions
- `node test/probe/capture-e2e.mjs`: headless end-to-end capture check on the fixture page (needs Chrome; `CHROME_BIN` to override the binary)
- `python3 -m http.server 8000` then open `http://localhost:8000/test/fixtures/long-page.html` for manual testing (`#tall` = oversized mode)
- `node scripts/make-icons.js`: regenerate the icons
