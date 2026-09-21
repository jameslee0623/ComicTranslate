# Bundled fonts (placeholder)

This directory is listed in the manifest's `web_accessible_resources` so that
translated text can be rendered with a font that actually covers the target
script. It is currently empty.

**Why it matters:** `CanvasRenderingContext2D.fillText` silently draws tofu boxes
when the resolved font has no glyphs for the target language. Firefox on macOS
and Windows has decent CJK coverage out of the box, but a Linux user translating
Japanese manga would get a page full of boxes.

**What goes here:** subsetted Noto Sans faces for the scripts we support, for
example:

```
NotoSansJP-subset.woff2
NotoSansKR-subset.woff2
NotoSansSC-subset.woff2
NotoSansArabic-subset.woff2
NotoSansHebrew-subset.woff2
```

**How they get used:** `src/content/textLayout.js` already falls back through a
font stack that names `Noto Sans CJK JP`, `Noto Sans Arabic` and `Noto Sans
Hebrew`. Once the files exist, a content script should register them with the
`FontFace` API and load them from
`browser.runtime.getURL('assets/fonts/<file>')` before the first render. That
registration step is deliberately not written yet, because loading fonts that do
not exist would throw on every page load.

Until then, translate *into* a Latin script for the best results, and set an
explicit font in the options page if the page already ships a suitable one.
