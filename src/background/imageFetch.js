/**
 * imageFetch.js - retrieve image bytes for an arbitrary page image.
 *
 * Runs in the background context because that is the only place with host
 * permissions, so the request is not subject to the page's CORS policy.
 *
 * Two-stage fallback:
 *   1. background fetch  - bypasses CORS, sends the browser's cookies
 *   2. content-script fetch - re-runs the request with the page's own session,
 *      which recovers hotlink-protected images (Referer is set by the browser,
 *      and a content script cannot set it itself: Referer is a forbidden header)
 */
'use strict';

if (typeof globalThis.CTImageFetch === 'undefined') {
  const DEFAULT_TIMEOUT_MS = 20000;

  /** Magic-byte sniffing: CDNs frequently serve images as application/octet-stream. */
  function sniffMime(bytes) {
    // Accepts an ArrayBuffer (from the background fetch) and a Uint8Array (from
    // base64 decoding at the message boundary). The offset/length constructor
    // form would silently misread a typed array as its backing buffer, so
    // normalise to a view first.
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const b = u8.subarray(0, Math.min(u8.length, 16));
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
    // RIFF/ISOBMFF (avif/heic) and SVG both start with ASCII.
    const head = String.fromCharCode.apply(null, b.subarray(0, 8));
    if (head.startsWith('avif') || head.startsWith('ftyp')) return 'image/avif';
    return 'application/octet-stream';
  }

  function normaliseMime(headerValue, bytes) {
    const sniffed = sniffMime(bytes);
    if (!headerValue) return sniffed;
    const bare = headerValue.split(';')[0].trim().toLowerCase();
    if (!bare || bare === 'application/octet-stream' || bare === 'binary/octet-stream') {
      return sniffed;
    }
    return bare;
  }

  async function withTimeout(promise, ms, label) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Stage 1: fetch from the background context with browser credentials. */
  async function fetchInBackground(url, timeoutMs) {
    const res = await withTimeout(
      fetch(url, { credentials: 'include', cache: 'force-cache', redirect: 'follow' }),
      timeoutMs,
      'background fetch'
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buffer = await res.arrayBuffer();
    if (!buffer.byteLength) throw new Error('empty body');
    return { bytes: buffer, mime: normaliseMime(res.headers.get('content-type'), buffer) };
  }

  /** Stage 2: ask the content script to fetch with the page's own session. */
  async function fetchViaContentScript(tabId, frameId, url, timeoutMs) {
    const reply = await withTimeout(
      browser.tabs.sendMessage(
        tabId,
        { type: 'CT_FETCH_IMAGE_IN_PAGE', url },
        typeof frameId === 'number' ? { frameId } : undefined
      ),
      timeoutMs,
      'content-script fetch'
    );
    if (!reply || !reply.ok) {
      throw new Error((reply && reply.error) || 'content-script fetch failed');
    }
    // The reply crossed a message boundary, so its bytes are base64-encoded.
    const unpacked = CTCodec.unpackReply(reply);
    const bytes = unpacked.bytes;
    if (!bytes || !bytes.length) throw new Error('content-script fetch returned no bytes');
    return { bytes, mime: normaliseMime(unpacked.mime, bytes) };
  }

  /**
   * @returns {Promise<{bytes: ArrayBuffer, mime: string, via: string}>}
   */
  async function fetchImageBytes(url, opts) {
    const options = opts || {};
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    const errors = [];

    try {
      const r = await fetchInBackground(url, timeoutMs);
      return Object.assign(r, { via: 'background' });
    } catch (e) {
      errors.push('background: ' + e.message);
    }

    if (typeof options.tabId === 'number') {
      try {
        const r = await fetchViaContentScript(options.tabId, options.frameId, url, timeoutMs);
        return Object.assign(r, { via: 'content-script' });
      } catch (e) {
        errors.push('content-script: ' + e.message);
      }
    }

    throw new Error('could not fetch image (' + errors.join('; ') + ')');
  }

  /** Decode dimensions from raw bytes using an ImageBitmap (no DOM needed here). */
  async function measure(bytes, mime) {
    const blob = new Blob([bytes], { type: mime });
    try {
      const bitmap = await createImageBitmap(blob);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return size;
    } catch (e) {
      return { width: 0, height: 0, error: e.message };
    }
  }

  globalThis.CTImageFetch = { fetchImageBytes, sniffMime, normaliseMime, measure };
}
