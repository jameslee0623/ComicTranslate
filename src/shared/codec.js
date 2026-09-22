/**
 * codec.js - byte transport across the extension message boundary.
 *
 * WHY THIS EXISTS
 * ---------------
 * Firefox serialises extension messages with the structured clone algorithm, so
 * an ArrayBuffer survives intact. **Chrome serialises them with JSON**, where a
 * typed array or ArrayBuffer silently arrives as `{}`. Image bytes therefore
 * worked fine on Firefox and would vanish without a word on Chrome.
 *
 * Chrome 148 adds an opt-in structured-clone mode, but it is brand new and off
 * by default, and mismatched serialisation formats make two contexts unable to
 * talk to each other at all. So bytes are base64-encoded instead: about 33%
 * larger on the wire, identical behaviour on every supported version of both
 * browsers, and one code path to test rather than two.
 *
 * Base64 is only used AT the boundary. Inside a context, bytes stay as
 * ArrayBuffer/Uint8Array; IndexedDB (the cache) uses structured clone natively
 * and needs no encoding.
 */
'use strict';

if (typeof globalThis.CTCodec === 'undefined') {
  /** Anything binary -> base64. Chunked because apply() has an argument limit. */
  function toBase64(bytes) {
    const u8 = bytes instanceof Uint8Array
      ? bytes
      : bytes instanceof ArrayBuffer
        ? new Uint8Array(bytes)
        : new Uint8Array(bytes.buffer || bytes);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  /** base64 -> Uint8Array. Always a Uint8Array, never an ArrayBuffer, so callers
   *  have one predictable type to handle. */
  function fromBase64(b64) {
    const binary = atob(String(b64 || ''));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  /**
   * Encode every byte field in a reply before it goes on the wire. Done in one
   * place so a new engine that returns bytes cannot forget to encode them - the
   * failure mode there is silent data loss, not an exception.
   *
   * Handles both shapes this extension uses:
   *   { bytes, mime }            - imageFetch / the in-page fetch reply
   *   { ..., image: { bytes } }  - a full-image engine result
   */
  function packReply(data) {
    if (!data || typeof data !== 'object') return data;
    const out = Object.assign({}, data);
    if (out.bytes) {
      out.bytesB64 = toBase64(out.bytes);
      delete out.bytes;
    }
    if (out.image && out.image.bytes) {
      out.image = {
        bytesB64: toBase64(out.image.bytes),
        mime: out.image.mime || 'image/png'
      };
    }
    return out;
  }

  /** The inverse of packReply, applied on the receiving side. */
  function unpackReply(data) {
    if (!data || typeof data !== 'object') return data;
    const out = Object.assign({}, data);
    if (out.bytesB64) {
      out.bytes = fromBase64(out.bytesB64);
      delete out.bytesB64;
    }
    if (out.image && out.image.bytesB64) {
      out.image = {
        bytes: fromBase64(out.image.bytesB64),
        mime: out.image.mime || 'image/png'
      };
    }
    return out;
  }

  globalThis.CTCodec = { toBase64, fromBase64, packReply, unpackReply };
}
