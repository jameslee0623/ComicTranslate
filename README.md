# ComicTranslate

A Firefox extension that finds images and comics on a page, translates the text
*inside* them, and swaps the picture for a translated version.

**Status:** working skeleton. The full pipeline, engine abstraction, renderer and
UI are implemented and load in Firefox. The Google Lens parser is written against
the DOM structure the extension *expects*, and ships with a diagnostic because
Google does not document that structure — see [Verifying it works](#verifying-it-works).

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
challenge     = method ⏎ path ⏎ Content-MD5 ⏎ Content-Type ⏎ X-Lara-Date
Content-MD5   = base64(SHA-256(body) truncated to 16 bytes)   ← the name lies
```

The returned JWT is reused until 5 s before expiry, refreshed via
`/v2/auth/refresh` (single-use rotated tokens), and every image call sends
`X-No-Trace: true` — per Lara's docs the content is never stored or trained on.

| | |
|---|---|
| **Cost** | 10,000 characters per image: ≈ 1 page/month on the free tier (API capped at 10k chars/mo), ≈ 50 pages/month on Pro ($9.99), ≈ $0.25/page when metered |
| **Models** | `inpainting` (default — removes text, rebuilds the background) · `overlay` (cheapest, text drawn over the original) · `generative` / `generative_fast` (redraws the page) |
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

### Offline verification

```bash
./tools/verify.sh
```

Five stages, all runnable without Node or a browser:

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
extension works in Firefox, and it cannot test the Lens parser — only the
diagnostics below can.

## Verifying it works

The endpoints are undocumented, so the extension ships a diagnostic rather than
pretending the pipeline is known-good.

1. Open a page with a comic page or manga panel.
2. Options → **Diagnostics** → **List candidates** — confirms images are being
   found at all. If this is empty, scroll the page so images load.
3. **Run diagnostic** — runs the real engine on one image and prints the
   regions it extracted, the detected language and the translated lines.

Outcomes, each with a clear meaning:

| Symptom | Meaning | Where to look |
|---|---|---|
| `regions: 0`, no server error | No text found — stylised lettering or a non-comic image | Try a cleaner page image |
| HTTP error from `crupload` | Google changed or throttled the OCR endpoint | Request shape in `lensProto.js` |
| `translator: HTTP 4xx` with regions present | The translate endpoint refused (rate-limit or block) | Raise `requestDelayMs`; `translator.js` |
| Translations empty but regions exist | Reply shape changed | `parseReply` in `translator.js` |
| Boxes land in the wrong place | Normalised→pixel maths, or a downscaled send | `boxToPixels` / `rescaleRegions` in `lensProto.js` |
| `Could not reach the ComicTranslate content script` | The page was open before the extension was loaded | Reload the page (F5) |

Note that the diagnostic ignores the Enabled switch on purpose, so a parser can
be debugged without translating anything yet.

Then flip **Enabled** in the toolbar popup.

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

1. Run the diagnostic on a real manga page and tune `lensScrape.js` against the
   actual DOM dump.
2. Bundle subsetted Noto fonts and register them with the `FontFace` API.
3. Add `googleCloudEngine.js` (Vision + Translation v3) behind the existing
   interface, so a key can be used when Lens breaks.
4. Add per-site CSS selector overrides for readers whose markup defeats the
   generic scanner.
