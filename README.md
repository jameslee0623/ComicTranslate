# ComicTranslate

A Firefox extension that finds images and comics on a page, translates the text
*inside* them, and swaps the picture for a translated version.

**Status:** working extension. The full pipeline, engine abstraction, renderer and
UI are implemented and load in Firefox. Three engines are available: anonymous
Google Lens OCR, Lara's official image API, and Lens OCR combined with Lara
text translation — see [Engines](#lara-translate-engine-official-paid).

---

## The important correction to the original idea

The request was "send the picture to Google Translate Images and use the
translated picture it returns". **That is not how it works**, and it is worth
being precise about why:

- Google Translate's *Images* feature has **no API**. It is a web UI.
- It does **not** return a translated picture. It returns **structured text**:
  OCR strings, bounding boxes and translations.
- The "translated picture" you see on `translate.google.com` is composited
  **client-side by Google's own JavaScript**, drawing text over the image.

There is no endpoint that eats a comic page and returns a translated comic page.
**We have to do the erasing and retypesetting ourselves** — which is also the part
that decides whether the output is readable. That is what this extension does.

## What the spike established

Before writing code, the three halves of the pipeline were tested with live
requests:

| Probe | Result | Consequence |
|---|---|---|
| `lens.google.com/v3/upload` (web UI) | **303** | Works without cookies, but the results page is a JS shell |
| `lens.google.com/translatedimage` | **500** | Upstream projects using it are already broken |
| `lensfrontend-pa.googleapis.com/v1/crupload` (Chrome Lens API) | **200** | Full OCR — text + normalised boxes + detected language, anonymously |
| `translate.googleapis.com/translate_a/single` | **IP-blocked** | Not usable |
| `clients5.google.com/translate_a/t` (`dict-chrome-ex`) | **200** | Text translation, batched `q` params, anonymously |

**Conclusion:** the pipeline is two plain HTTP calls — Chrome's own Lens
endpoint for OCR (`lensProto.js`), then the dict-chrome-ex endpoint for
translation (`translator.js`). No cookies, no account, no hidden tab. The first
prototype did drive a hidden tab and scrape the rendered results page; live
testing showed that page never exposes per-line boxes (only a Translate
button), so that path was removed.

This is still the most fragile part of the project: both endpoints are
undocumented and can change or start blocking without notice.

## Architecture

```
[1] DETECT          [2] EXTRACT        [3] TRANSLATE       [4] ERASE+RENDER     [5] REPLACE
imageScanner.js  →  imageFetch.js  →  lensEngine.js   →  painter.js +      →  replaceImage.js
find <img> +        background fetch  proto OCR +        textLayout.js        blob src swap or
CSS backgrounds     content fallback  text translate     inpaint + typeset    CSP-proof overlay
                    content fallback
                     \__________________ engines.js routes all three _______/
```

**Background** (Firefox MV3 runs an *event page*, not a service worker):
`settings.js` · `cache.js` · `imageFetch.js` · `translator.js` · `protobuf.js` · `lensProto.js` · `lensEngine.js` · `laraEngine.js` · `engines.js` · `background.js`

**Content scripts** (ordered, classic scripts):
`textLayout.js` · `painter.js` · `imageScanner.js` · `replaceImage.js` · `content.js`

**UI:** `src/popup/` · `src/options/` · `src/shared/languages.js`

### Design decisions worth knowing

**Canvas tainting is tested before it is paid for.** Drawing a cross-origin
`<img>` taints the canvas, and the painter needs `getImageData` to sample speech
bubble colours. `content.js` probes this up front with a 2×2 test, and only then
asks the background to ship pixel bytes. Most readers need no transfer at all.

**Erasing is colour-based, not inpainting.** Comic lettering sits on flat bubble
white, so sampling the *ring around* the text box (never the inside, which is full
of glyph pixels) and filling reproduces the bubble almost perfectly for
near-zero cost. A real inpaint pass on a 5 MB webtoon strip would not.

**The overlay fallback involves no URL.** A strict page CSP can refuse `blob:` and
`data:` images. Swapping `src` is tried first and verified by waiting for an
actual decode; if that fails, the rendered `<canvas>` is positioned over the
original instead — no URL is involved, so no CSP directive can block it.

**`srcset` must be cleared, not just `src`.** Otherwise the browser keeps serving
the original responsive variant and the swap silently does nothing.

**Re-translation preserves the true original.** Switching target language
restores the page and clears the seen-set. Without preserving `originalSrc` across
passes, "Restore page" would restore a translation.

**Lazy-loaded images fire no DOM mutation.** A capture-phase `load` listener
covers images that decode after being inserted, which infinite-scroll readers
depend on.

**One scan at a time, serialized.** `background.js` funnels every translation
through a promise chain, which rate-limits us against Google — the same reason
`requestDelayMs` exists.

**Failures retry; empty results do not.** Marking an image done before
translating would let one rate-limit response silently skip a panel forever. So
transport failures are retried (bounded at 2 attempts), while "OCR found no text"
is treated as final — retrying that would just re-upload the image for nothing.

**Defaults are the cost-safe ones.** A fresh install uses the free Lens engine
(no key, no quota, no bill) and ignores images under 600px, so thumbnail grids,
icons and avatars are never uploaded. The paid engines stay strictly opt-in:
the Lara image engine bills a flat 10,000 characters per picture — the entire
monthly API allowance of the free plan — and 40 pages is ~400,000 characters.

**A quota rejection stops the run.** 402/429 is terminal, not transient, so the
queue breaks on the first one instead of making a refused request for every
remaining image (and re-uploading it to Google on the OCR route). It stays
stopped until settings change or you press **Translate now**, so topping up
takes effect immediately without re-firing doomed calls on every page mutation.

## Engine abstraction

`engines.js` defines the contract; nothing else imports a provider directly.

```js
{
  id: 'lens',
  label: '...',
  needsKey: false,
  doesTranslation: true,   // false → the shared translator runs afterwards
  async imageToRegions({ bytes, mime, width, height, sourceLang, targetLang, settings })
    -> { regions: [{ text, translated, bbox:{x,y,w,h}, confidence }], diagnostics }
}
```

Adding Google Cloud Vision plus Cloud Translation is **one new file** and one
registry line in `engines.js`. That was the point of the abstraction: the free
path is fragile, and the paid path is the reliable escape hatch.

## Lara Translate engine (official, paid)

`laraEngine.js` adds a second engine that replaces the whole undocumented Lens
chain with **one official API call**:

```
POST https://api.laratranslate.com/v2/images/translate
  multipart: image, source, target, model   ->   binary translated image
```

The server does OCR, text removal, background reconstruction and typesetting;
the extension receives a finished bitmap and puts it into the page with the
same blob-src → CSP-proof-overlay fallback the Lens path uses. No local OCR,
painting or font handling is involved — and no undocumented endpoint either.

Auth mirrors the official browser SDK exactly (translated/lara-node,
`src/crypto/browser-crypto.ts`): `POST /v2/auth` with

```
Authorization: Lara:<base64(HMAC-SHA256(challenge, secret))>
challenge     = method ⏎ full path ⏎ Content-MD5 ⏎ Content-Type ⏎ X-Lara-Date
Content-MD5   = base64(SHA-256(body) truncated to 16 bytes)   ← the name lies
```

The path in the challenge is the **full** request URI (`/v2/auth`): the server
rebuilds the challenge from what it receives, so signing a relative path fails
with `Invalid challenge signature`.

The returned JWT is reused until 5 s before expiry, refreshed via
`/v2/auth/refresh` (single-use rotated tokens), and every image call sends
`X-No-Trace: true` — per Lara's docs the content is never stored or trained on.

| | |
|---|---|
| **Cost** | 10,000 characters per image: ≈ 1 page/month on the free tier (API capped at 10k chars/mo), ≈ 50 pages/month on Pro ($9.99), ≈ $0.25/page when metered |
| **Models** | `inpainting` (default — removes the original text and rebuilds the background; the only mode that makes a comic read cleanly) · `overlay` (text drawn over the original, which stays visible) · `generative` / `generative_fast` (redraws the page). **All four bill the same flat 10,000 per image**, so this is a quality/speed choice, not a cost one |
| **Formats** | PNG · JPEG · **WebP** · AVIF · GIF · BMP · TIFF |
| **Languages** | full locale codes; omitting `source` enables auto-detection |

Setup: Settings → Engine → *Lara Translate*, paste the Access Key ID and
Secret from
[app.laratranslate.com/account/credentials](https://app.laratranslate.com/account/credentials),
press **Test Lara credentials** (a free `/v2/auth` call — a test *image* would
bill quota), then translate as usual. Every result is cached against
pixels + engine + model + target language, so re-reading a page is always
free. The free Lens engine stays the default; Lara is strictly opt-in.

### The free route: Lens OCR + Lara's text API

The image API bills a flat 10,000 characters per picture — one page a month on
the free tier. The **`lens-lara`** engine is the cheap alternative: anonymous
Lens crupload still finds the boxes and detects the language (identical to the
free engine), and only the *text* goes to Lara's `POST /v2/translate`, batched
into one call per page. Lara bills real characters there — a manga page is
usually 500–1,500 chars — so the free tier's 10k/month covers roughly 10–20
pages, and Pro's 500k covers hundreds. Same credentials, same cache discipline,
same locally-painted output as the Lens engine.

### Icon, progress animation, usage meter

- **Icons are generated, not hand-drawn**: `python3 tools/make_icons.py` renders
  `assets/icons/icon-{32,48,96,128}.png` from an analytic scene (indigo rounded
  square, speech bubble, "A" + 文) with 4× supersampling. Pure stdlib — no
  Pillow, no design tools — so the icons are reproducible from the repo.
- **"Is it still translating?"** is answered two ways while work is in flight:
  the toolbar icon becomes a rotating arc (canvas-drawn frames swapped through
  `browser.action.setIcon`, restored to the static icon when the queue idles),
  and the page shows a top-right chip — `Translating… 3/12 · 2,430 / 10,000
  chars`. The chip's spinner uses the Web Animations API, so a page's CSP
  cannot block it; click the chip to dismiss it.
- **The usage meter** (`usage.js`) counts what Lara actually bills: text
  characters sent (`lens-lara`) plus a flat 10,000 per full-image call. It is
  shown month-to-date against a configurable cap (default 10,000 = free tier)
  in the popup, on the options page (progress bar + breakdown), and in the
  in-page chip. Cache hits are never counted, since they never reach Lara. The
  counter follows the calendar month — Lara's own reset day is account-specific
  — so the options page has a manual reset button.

## Loading it in Firefox

Node is **not** required — there is no build step. All scripts are classic,
load-order dependent, and every file is cross-checked for syntax and internal
consistency.

1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…**
3. Select `/Users/james/FirefoxDev/ComicTranslate/manifest.json`
4. **Reload every page you want to translate.** Content scripts are injected when
   a page loads, so a tab that was already open when you loaded or reloaded the
   extension has no content script in it, and every message to it will fail.
5. After editing files, press **Reload** on the extension card, then reload the
   page again.

Turn on `debug` in the options page, then watch the **Browser Console**
(`Cmd+Shift+J`) for `[CT]` and `[CT/lens]` lines.

Firefox loads the **repo root** `manifest.json` directly — no build step. That
is the opposite of Chrome, which must load `dist/chrome` (next section); the
build exists because the two browsers cannot share one manifest shape.

## Loading it in Chrome

**Chrome must load `dist/chrome`, never the repo root.** The root
`manifest.json` is the Firefox source shape — Chrome rejects it outright
because of `background.scripts`, and the error Chrome shows for that is an
unhelpful generic one. If you pointed Chrome at the repo root, that is the
whole problem; run the build and load `dist/chrome` instead.

Node is **not** required, but Python 3 is (it only writes files):

```bash
python3 tools/build.py           # both targets, into dist/
python3 tools/build.py --chrome  # just dist/chrome
python3 tools/build.py --firefox # just dist/firefox (identical copy of the tree)
```

Then in Chrome:

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. **Load unpacked** → select the **`dist/chrome` folder** (not the repo root)
4. After rebuilding (`python3 tools/build.py`), press the **Reload** ↻ on the
   ComicTranslate card, then reload the page you are translating — same rule
   as Firefox: content scripts only inject on page load.

### Where the logs are in Chrome

- **Background (service worker):** `chrome://extensions` → ComicTranslate →
  **Inspect views: service worker**. You should see
  `[CT] background up: Chrome service worker`.
- **Page (content script):** the page's own DevTools console
  (right-click → Inspect). You should see
  `[CT/content] ready on <host>` — if it is absent, the content script is not
  in the page (reload the page after any extension reload).
- Turn on `debug` in the options page for the per-step `[CT]` engine lines.

### What differs between the two browsers, and how it is handled

| | Firefox | Chrome |
|---|---|---|
| Background | non-persistent **event page** (`background.scripts`, 14 files) | **service worker** (`background.service_worker`, one file) |
| Message serialisation | structured clone — `ArrayBuffer` survives | JSON — `ArrayBuffer` does **not** survive |
| `browser` global | native | does not exist; aliased from `chrome` |

- **`src/shared/compat.js`** — first script in *every* context (background via
  both load paths, content scripts, popup, options). If `browser` is missing it
  aliases `globalThis.browser = chrome`, so all other code says `browser.*` and
  never branches on the engine.
- **`src/shared/codec.js` (`CTCodec`)** — Chrome's JSON message channel drops
  `ArrayBuffer`, which is how translated image bytes travel. Replies are
  wrapped with `packReply`/`unpackReply` at both ends of every byte-carrying
  message: `ArrayBuffer` → `bytesB64` string on the wire, decoded back at the
  receiver. On Firefox this is a pass-through; the base64 detour is only paid
  where it is required.
- **Listener shape** — every `onMessage` listener replies via `sendResponse`
  plus `return true`, never by returning a Promise. Firefox accepts both
  shapes; Chrome ignores returned Promises and drops the reply without the
  explicit `true`.
- **`importScripts`** — Chrome reaches the other 13 background modules through
  `importScripts` at the top of `background.js` (it ignores
  `background.scripts` entirely). That list is a second, independent source of
  truth — a module missing from it loads in Firefox and is *silently absent in
  Chrome* — so `build.py` resolves every `importScripts` entry and the semantic
  checker cross-checks both lists against the files on disk.
- **Build output** — `dist/chrome/manifest.json` swaps the `background` block
  for `service_worker` and adds `minimum_chrome_version: 111`; the two `dist`
  trees differ in exactly one file, and `build.py` refuses to emit a Chrome
  manifest that still contains `scripts`.

### Offline verification

```bash
./tools/verify.sh
```

Six stages, all runnable without Node or a browser:

1. **Syntax** — every JS file is parsed with JavaScriptCore (`jsc`).
2. **Load** — every module is actually *evaluated* against stubbed browser
   globals, and each namespace is asserted to export its full API.
3. **Functional** — 26 assertions over the pure content logic: script
   tokenisation, line wrapping, hard-breaking of overlong words, font-size
   fitting, luminance and bubble-colour sampling, box clamping.
4. **Lara** — unit tests over the engine's string plumbing with stubbed
   WebCrypto/fetch: the HMAC challenge vector, the truncated `Content-MD5`
   digest, token expiry maths, multipart assembly and the 401 re-auth path.
5. **Semantic** — manifest paths exist, every element id the UI scripts touch
   exists in the HTML, every settings key the UI writes exists in `DEFAULTS`,
   and every `CT*` method called cross-module is actually exported.
6. **Browser** — the cross-browser guards: `CTCodec` pack/unpack survives a
   real JSON round trip (the Chrome channel), the base64 chunking handles
   0x8000 boundaries, the **unpacked control proves bytes are lost through
   JSON** (the regression the codec exists to prevent), and `CTCompat` aliases
   a Chrome-shaped environment correctly in background, content and page
   contexts.

### Why the Load stage exists

It was added because of a real bug that shipped past every other check. A file
ended with

```js
globalThis.CTLensScrape = Object.assign(globalThis.CTLensScrape, { ... });
```

without ever assigning `globalThis.CTLensScrape` first. That throws at load time
on every page, leaving the namespace undefined, so the Lens scrape message failed
and reported `"no content-script reply from result tab"`.

| Check | Buggy code |
|---|---|
| Syntax | passed — valid syntax |
| Load | **failed — `THREW AT LOAD: Object.assign requires...`** |
| Functional | passed — only pure logic was exercised |
| Semantic | passed — it had a `continue` for namespaces it could not enumerate statically |

Three of four checks missed it. The lesson is that static analysis needs a
counterpart that actually *runs* the module's top level. (The list above is now
five stages — stage 4 covers the Lara engine.)

`verify.sh` proves the code is self-consistent. It does **not** prove the
extension works in Firefox — only translating a real page does that
(see [Verifying it works](#verifying-it-works)).

## Verifying it works

1. Load the extension via `about:debugging#/runtime/this-firefox` → Load
   Temporary Add-on → `manifest.json`.
2. Open a page with a comic page or manga panel, enable the extension in the
   toolbar popup, and watch the page translate in place.

Outcomes are visible on the page itself and in the background console
(`about:debugging` → Inspect → Console, with verbose logging enabled in
Advanced settings):

| Symptom | Meaning | Where to look |
|---|---|---|
| `regions: 0`, no server error | No text found — stylised lettering or a non-comic image | Try a cleaner page image |
| HTTP error from `crupload` | Google changed or throttled the OCR endpoint | Request shape in `lensProto.js` |
| `translator: HTTP 4xx` with regions present | The translate endpoint refused (rate-limit or block) | Raise `requestDelayMs`; `translator.js` |
| Translations empty but regions exist | Reply shape changed | `parseReply` in `translator.js` |
| Boxes land in the wrong place | Normalised→pixel maths, or a downscaled send | `boxToPixels` / `rescaleRegions` in `lensProto.js` |
| `No content script on this page ... (Receiving end does not exist)` | Either the page predates the extension load, **or** a content-script file failed to load on every page | Reload the page (F5); if that changes nothing, the page console names the offending file — run `./tools/verify.sh`, which catches syntax errors and load-time throws |

The popup's **Translate now / Restore page** buttons force a re-run without
touching settings.

## Known limitations

- **Every processed image is uploaded to Google.** Inherent to the feature, not a
  bug. Requests are anonymous — no cookies or account data are sent.
- **`blob:`-src and canvas-rendered readers** cannot be fetched or re-decoded and
  are skipped by design.
- **Closed shadow DOM** is inaccessible. Cross-origin iframes are handled
  (`all_frames: true`).
- **Non-Latin targets need a bundled font.** Without one, `fillText` draws tofu.
  See `assets/fonts/README.md`.
- **Stylized/hand-lettered comic fonts** are the hardest OCR case. Lens handles
  this better than generic OCR, but perfection is not realistic.
- **Terms of Service.** This uses undocumented Google endpoints. It may
  break, and it may not pass addons.mozilla.org review as-is.

## Next steps, in the order I would do them

1. Bundle subsetted Noto fonts and register them with the `FontFace` API.
2. Add `googleCloudEngine.js` (Vision + Translation v3) behind the existing
   interface, so a key can be used when Lens breaks.
3. Add per-site CSS selector overrides for readers whose markup defeats the
   generic scanner.
