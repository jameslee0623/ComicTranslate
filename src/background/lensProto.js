/**
 * lensProto.js - Google Lens OCR via the protobuf API.
 *
 * WHY THIS EXISTS
 * ---------------
 * The first implementation drove a hidden browser tab to Google's Lens results
 * page and scraped positioned DOM elements. Live testing proved that approach
 * cannot work: the results page is a JS app that only offers a "Translate"
 * button, never rendering per-line text boxes, so the scraper found exactly one
 * "box" - the button itself.
 *
 * The endpoint that Chrome's own Lens overlay uses is far better:
 *
 *   POST https://lensfrontend-pa.googleapis.com/v1/crupload
 *   Content-Type: application/x-protobuf
 *   X-Goog-Api-Key: <public Chrome client key>
 *
 * It is a plain HTTP API. Verified working anonymously: no Google account, no
 * cookies, no browser. It returns OCR text per word and per line with normalised
 * boxes, plus the detected source language. One request instead of an upload, a
 * navigation and a polling loop.
 *
 * The API does NOT translate (verified: requesting the TRANSLATE filter still
 * returned the original English), so translation is a separate step handled by
 * translator.js.
 *
 * Field numbers come from chrome-lens-ocr's generated protobuf classes. See
 * protobuf.js for the wire codec.
 */
'use strict';

if (typeof globalThis.CTLensProto === 'undefined') {
  const PROTO_ENDPOINT = 'https://lensfrontend-pa.googleapis.com/v1/crupload';
  /** Public client key shipped inside Chrome's Lens overlay. Not a secret. */
  const API_KEY = 'AIzaSyDr2UxVnv_U85AbhhY8XSHSIavUW0DC-sY';
  const DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  /** LensOverlayFilterType */
  const FILTER_AUTO = 7;
  const FILTER_TRANSLATE = 2;

  /** CoordinateType.NORMALIZED - all observed responses use this. */
  const COORD_NORMALIZED = 1;

  const MAX_BYTES = 4000000; // Lens rejects very large payloads; guard before sending

  function log(settings, ...args) {
    if (settings && settings.debug) console.log('[CT/lensProto]', ...args);
  }

  // ------------------------------------------------------------------ request

  /**
   * Build LensOverlayServerRequest{ 1: ObjectsRequest }.
   * @returns {Uint8Array} serialised request body
   */
  function buildRequest(imageBytes, width, height, opts) {
    const options = opts || {};
    const P = CTProto;

    const uuid = String(Date.now()) + String(Math.floor(Math.random() * 1000000));
    const requestId = P.concat([
      P.fBytes(1, uuid),   // RequestId.Uuid
      P.fInt(2, 1),        // RequestId.SequenceId
      P.fInt(3, 1)         // RequestId.ImageSequenceId
    ]);

    const locale = P.concat([
      P.fBytes(1, options.locale || 'en'),          // LocaleContext.Language
      P.fBytes(2, options.region || 'US'),          // LocaleContext.Region
      P.fBytes(3, options.timeZone || 'America/New_York')
    ]);

    // The Auto filter is what an OCR scan uses; TRANSLATE was tried and does not
    // return translated text, so we always scan and translate afterwards.
    const filter = P.fInt(1, FILTER_AUTO);
    const filters = P.fBytes(1, filter);            // AppliedFilters.filter (repeated)

    const clientContext = P.concat([
      P.fInt(1, 2),                 // ClientPlatform.CLIENT_PLATFORM_LENS_OVERLAY
      P.fInt(2, 4),                 // Surface.SURFACE_CHROMIUM
      P.fBytes(4, locale),          // ClientContext.LocaleContext
      P.fBytes(17, filters)         // ClientContext.ClientFilters
    ]);

    const requestContext = P.concat([
      P.fBytes(3, requestId),       // RequestContext.RequestId
      P.fBytes(4, clientContext)    // RequestContext.ClientContext
    ]);

    const imageData = P.concat([
      P.fBytes(1, P.fBytes(1, imageBytes)),                     // Payload.ImageBytes
      P.fBytes(3, P.concat([P.fInt(1, width), P.fInt(2, height)])) // ImageMetadata
    ]);

    const objectsRequest = P.concat([
      P.fBytes(1, requestContext),  // ObjectsRequest.RequestContext
      P.fBytes(3, imageData)        // ObjectsRequest.ImageData
    ]);

    return P.fBytes(1, objectsRequest); // ServerRequest.ObjectsRequest
  }

  // ----------------------------------------------------------------- decode

  function firstValues(chunk) {
    const map = {};
    new CTProto.Reader(chunk).each((f, w, v) => {
      if (!(f in map)) map[f] = v;
    });
    return map;
  }

  function parseBox(chunk) {
    try {
      const map = firstValues(chunk);
      return {
        cx: map[1] || 0, cy: map[2] || 0,
        w: map[3] || 0, h: map[4] || 0,
        rotation: map[5] || 0,
        coord: map[6] == null ? COORD_NORMALIZED : map[6]
      };
    } catch {
      return null;
    }
  }

  function parseGeometry(chunk) {
    let box = null;
    try {
      new CTProto.Reader(chunk).each((f, w, v) => {
        if (f === 1 && w === 2 && !box) box = parseBox(v);
      });
    } catch {
      return null;
    }
    return box;
  }

  function parseWord(chunk) {
    const word = { text: '', separator: '', geometry: null };
    new CTProto.Reader(chunk).each((f, w, v) => {
      if (w !== 2) return;
      if (f === 2) {
        const text = CTProto.decodeUtf8(v);
        if (text) word.text = text;
      } else if (f === 3) {
        const sep = CTProto.decodeUtf8(v);
        if (sep) word.separator = sep;
      } else if (f === 4) {
        word.geometry = parseGeometry(v);
      }
    });
    return word;
  }

  function parseLine(chunk) {
    const words = [];
    let geometry = null;
    new CTProto.Reader(chunk).each((f, w, v) => {
      if (w !== 2) return;
      if (f === 1) {
        const word = parseWord(v);
        if (word.text) words.push(word);
      } else if (f === 2) {
        geometry = parseGeometry(v) || geometry;
      }
    });
    let text = '';
    words.forEach((word, i) => {
      text += word.text;
      if (word.separator) text += word.separator;
      else if (i < words.length - 1) text += ' ';
    });
    return { text: text.replace(/\s+/g, ' ').trim(), geometry, words };
  }

  function parseParagraph(chunk) {
    const lines = [];
    let geometry = null;
    let writing = null;
    let language = '';
    new CTProto.Reader(chunk).each((f, w, v) => {
      if (f === 2 && w === 2) {
        const line = parseLine(v);
        if (line.text) lines.push(line);
      } else if (f === 3 && w === 2) {
        geometry = parseGeometry(v) || geometry;
      } else if (f === 4 && w === 0) {
        writing = v;
      } else if (f === 5 && w === 2) {
        const text = CTProto.decodeUtf8(v);
        if (text) language = text;
      }
    });
    return {
      lines,
      geometry,
      writing,
      language,
      // Populated only when the lines did not parse, so regionsFromText can still
      // emit something instead of silently dropping the text.
      fallbackText: lines.length ? '' : collectWordsDeep(chunk, [], 0)
        .map((w) => w.text).join(' ')
    };
  }

  /**
   * A word whose field 4 carries no geometry still has usable text; such words
   * are attached to their line's box so the translation is not dropped.
   */
  function parseText(chunk) {
    const paragraphs = [];
    let language = '';
    new CTProto.Reader(chunk).each((f, w, v) => {
      if (f === 1 && w === 2) {
        // Text.f1 is the TextLayout, and TextLayout.f1 is the repeated Paragraph.
        // Skipping this intermediate level is what made the first version of this
        // decoder report paragraphs that contained no lines.
        new CTProto.Reader(v).each((f2, w2, v2) => {
          if (f2 === 1 && w2 === 2) paragraphs.push(parseParagraph(v2));
        });
      } else if (f === 2 && w === 2) {
        const text = CTProto.decodeUtf8(v);
        if (text) language = text;
      }
    });
    if (!language && paragraphs.length) language = paragraphs[0].language || '';
    return { paragraphs, language };
  }

  /**
   * Does this sub-message look like a Word?
   *
   * Requires field 2 to be printable text AND either field 1 (Id) or field 4
   * (Geometry) to be present. That combination distinguishes a real Word from the
   * many unrelated strings in the payload (opaque IDs such as "text:0:ozAg...").
   */
  function looksLikeWord(chunk) {
    try {
      const map = firstValues(chunk);
      const raw = map[2];
      if (!raw || typeof raw !== 'object') return null;
      const text = CTProto.decodeUtf8(raw);
      if (!text || !text.trim()) return null;
      // A usable Word carries geometry (field 4): without a box it could not be
      // painted anyway. Requiring it rejects the many unrelated submessages in
      // the payload - e.g. the Text message itself (field 2 = ContentLanguage,
      // "en") and locale-ish containers - which would otherwise stop the
      // descent before any words are found.
      if (map[4] === undefined) return null;
      return text;
    } catch {
      // The sweep deliberately probes chunks that may not be messages at all, so a
      // malformed one must be ignored rather than propagated.
      return null;
    }
  }

  /**
   * Recursive word sweep, used when the typed walk finds a paragraph but no lines
   * (observed on a Japanese sample). Bounded by depth and count so a malformed
   * payload cannot spin, and fully exception-tolerant because it inspects chunks
   * that are not known to be messages.
   */
  function collectWordsDeep(chunk, out, depth) {
    if (depth > 8 || out.length > 500) return out;
    try {
      new CTProto.Reader(chunk).each((f, w, v) => {
        if (w !== 2) return;
        const text = looksLikeWord(v);
        // Descend even after a match: a false positive high in the tree (a
        // submessage that happens to look like a Word) must not cut off the
        // real words below it. Words contain no nested words, so this cannot
        // produce duplicates, only recover.
        if (text) out.push({ field: f, text: text.trim() });
        if (depth < 8) collectWordsDeep(v, out, depth + 1);
      });
    } catch {
      // Not a parseable message; nothing to recover from this branch.
    }
    return out;
  }

  // ---------------------------------------------------------------- top level

  /**
   * ServerResponse{ 1: Error, 2: ObjectsResponse{ 3: Text } }
   * @returns {{error: Object|null, language: string, paragraphs: Array}}
   */
  function parseResponse(bytes) {
    let error = null;
    let language = '';
    let paragraphs = [];

    new CTProto.Reader(bytes).each((field, wire, value) => {
      if (wire !== 2) return;
      if (field === 1) {
        error = firstValues(value);
      } else if (field === 2) {
        new CTProto.Reader(value).each((f2, w2, v2) => {
          if (f2 === 3 && w2 === 2) {
            const text = parseText(v2);
            if (text.paragraphs.length) paragraphs = text.paragraphs;
            if (text.language) language = text.language;
          }
        });
      }
    });

    return { error, language, paragraphs };
  }

  /** Normalised centre+size box to integer pixels in the original image. */
  function boxToPixels(box, width, height) {
    const w = box.w * width;
    const h = box.h * height;
    return {
      x: Math.round(box.cx * width - w / 2),
      y: Math.round(box.cy * height - h / 2),
      w: Math.round(w),
      h: Math.round(h)
    };
  }

  /** Regions measured on a rescaled copy of the image (see toUploadable in
   *  lensEngine.js) are mapped back onto the original pixel grid here. */
  function rescaleRegions(regions, fromW, fromH, toW, toH) {
    if (!(fromW > 0 && fromH > 0 && toW > 0 && toH > 0)) return regions;
    if (fromW === toW && fromH === toH) return regions;
    const sx = toW / fromW;
    const sy = toH / fromH;
    return regions.map((r) => Object.assign({}, r, {
      bbox: {
        x: Math.round((r.bbox.x || 0) * sx),
        y: Math.round((r.bbox.y || 0) * sy),
        w: Math.round((r.bbox.w || 0) * sx),
        h: Math.round((r.bbox.h || 0) * sy)
      }
    }));
  }

  /**
   * Flatten paragraphs into one region per line.
   *
   * Line granularity is right for comics: one speech bubble is usually one or two
   * lines, so each line can be erased and retypeset inside its own box without
   * disturbing neighbouring art.
   */
  function regionsFromText(parsed, width, height) {
    const regions = [];
    let sawLine = false;

    for (const paragraph of parsed.paragraphs) {
      for (const line of paragraph.lines) {
        const geometry = line.geometry || paragraph.geometry;
        if (!geometry) continue;
        sawLine = true;
        regions.push({
          text: line.text,
          translated: '',
          bbox: boxToPixels(geometry, width, height),
          direction: paragraph.writing === 1 ? 'rtl' : 'auto',
          confidence: null
        });
      }
    }

    // Fallback: a variant response whose lines did not parse. Recover the words
    // so the text is at least not lost, placed in the paragraph's box.
    if (!sawLine) {
      for (const paragraph of parsed.paragraphs) {
        if (!paragraph.geometry || !paragraph.fallbackText) continue;
        regions.push({
          text: paragraph.fallbackText,
          translated: '',
          bbox: boxToPixels(paragraph.geometry, width, height),
          direction: 'auto',
          confidence: null
        });
      }
    }

    return regions.filter((r) => r.text && r.text.trim() && r.bbox.w > 1 && r.bbox.h > 1);
  }

  /**
   * Run OCR on an image.
   * @returns {Promise<{regions: Array, sourceLang: string, diagnostics: Object}>}
   */
  async function scan(imageBytes, width, height, settings, opts) {
    const bytes = new Uint8Array(imageBytes);
    if (bytes.byteLength > MAX_BYTES) {
      throw new Error('image is too large for the Lens API: ' + bytes.byteLength + ' bytes');
    }

    const body = buildRequest(bytes, width, height, opts || {});
    log(settings, 'POST', PROTO_ENDPOINT, bytes.byteLength, 'bytes');

    // User-Agent is a forbidden header in fetch and is dropped by the browser, so
    // it is deliberately not set here.
    const res = await fetch(PROTO_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-protobuf',
        'X-Goog-Api-Key': API_KEY,
        'Accept': '*/*'
      },
      body
    });

    if (!res.ok) {
      throw new Error('Lens protobuf API returned HTTP ' + res.status);
    }

    const buffer = await res.arrayBuffer();
    const parsed = parseResponse(new Uint8Array(buffer));
    const regions = regionsFromText(parsed, width, height);

    log(settings, 'OCR done', {
      language: parsed.language,
      paragraphs: parsed.paragraphs.length,
      regions: regions.length
    });

    return {
      regions,
      sourceLang: parsed.language || '',
      diagnostics: {
        language: parsed.language,
        paragraphCount: parsed.paragraphs.length,
        regionCount: regions.length,
        responseBytes: buffer.byteLength,
        serverError: parsed.error || null,
        words: collectWordsDeep(new Uint8Array(buffer), [], 0)
          .map((w) => w.text).slice(0, 40)
      }
    };
  }

  globalThis.CTLensProto = Object.assign(globalThis.CTLensProto || {}, {
    PROTO_ENDPOINT,
    API_KEY,
    DEFAULT_UA,
    FILTER_AUTO,
    FILTER_TRANSLATE,
    MAX_BYTES,
    buildRequest,
    parseBox,
    parseGeometry,
    parseWord,
    parseLine,
    parseParagraph,
    parseText,
    looksLikeWord,
    collectWordsDeep,
    parseResponse,
    boxToPixels,
    rescaleRegions,
    regionsFromText,
    scan,
    log
  });
}