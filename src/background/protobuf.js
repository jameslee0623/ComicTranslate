/**
 * protobuf.js - minimal protobuf wire codec.
 *
 * We cannot use google-protobuf or any npm package: this machine has no Node and
 * the extension has no build step. The Lens protobuf API only needs a small
 * subset of the wire format, so it is implemented directly here.
 *
 * Wire types used:
 *   0  varint          (ints, bools, enums)
 *   1  fixed64         (double)
 *   2  length-delimited(strings, bytes, nested messages)
 *   5  fixed32         (float)
 *
 * Field numbers were extracted from chrome-lens-ocr's generated classes; see
 * lensProto.js for the schema as it applies to Lens.
 */
'use strict';

if (typeof globalThis.CTProto === 'undefined') {
  const WIRE_VARINT = 0;
  const WIRE_FIXED64 = 1;
  const WIRE_BYTES = 2;
  const WIRE_FIXED32 = 5;

  // ------------------------------------------------------------------ encode

  function varintBytes(value) {
    // Guard against the negative-number case: protobuf encodes negative int32 as
    // a full 10-byte varint, which naive shifting would turn into an infinite loop.
    let n = value >>> 0 === value ? value : Math.abs(value) * 2 + (value < 0 ? 1 : 0);
    const out = [];
    do {
      let byte = n & 0x7f;
      n = Math.floor(n / 128);
      if (n > 0) byte |= 0x80;
      out.push(byte);
    } while (n > 0);
    return out;
  }

  function concat(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  }

  function tagField(fieldNumber, wireType) {
    return new Uint8Array(varintBytes((fieldNumber << 3) | wireType));
  }

  /** Wire type 0. */
  function fInt(fieldNumber, value) {
    return concat([tagField(fieldNumber, WIRE_VARINT), new Uint8Array(varintBytes(value))]);
  }

  function toBytes(payload) {
    if (payload instanceof Uint8Array) return payload;
    if (typeof payload === 'string') return encodeUtf8(payload);
    if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
    if (ArrayBuffer.isView(payload)) {
      return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
    }
    throw new TypeError('unsupported payload type');
  }

  /**
   * UTF-8 encode. Uses the platform TextEncoder when present (Firefox always has
   * it) and falls back to a manual encoder otherwise, which keeps this module
   * usable under a bare JS engine such as jsc for testing.
   */
  function encodeUtf8(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let code = str.codePointAt(i);
      if (code > 0xffff) i++;                    // consume the surrogate pair
      if (code < 0x80) {
        out.push(code);
      } else if (code < 0x800) {
        out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code < 0x10000) {
        out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      } else {
        out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f),
                 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      }
    }
    return new Uint8Array(out);
  }

  /**
   * Strict UTF-8 decode. Returns '' for anything that is not valid UTF-8, which
   * is what lets the Lens decoder distinguish real OCR text from the opaque bytes
   * and binary geometry that share the payload.
   */
  function manualDecodeUtf8(bytes) {
    let out = '';
    let i = 0;
    while (i < bytes.length) {
      const b0 = bytes[i++];
      if (b0 < 0x80) {
        out += String.fromCharCode(b0);
        continue;
      }
      let need;
      let code;
      if ((b0 & 0xe0) === 0xc0) { need = 1; code = b0 & 0x1f; }
      else if ((b0 & 0xf0) === 0xe0) { need = 2; code = b0 & 0x0f; }
      else if ((b0 & 0xf8) === 0xf0) { need = 3; code = b0 & 0x07; }
      else return '';                            // invalid lead byte

      for (let n = 0; n < need; n++) {
        if (i >= bytes.length) return '';        // truncated sequence
        const next = bytes[i++];
        if ((next & 0xc0) !== 0x80) return '';   // invalid continuation byte
        code = (code << 6) | (next & 0x3f);
      }
      if (code > 0x10ffff) return '';
      if (code > 0xffff) {
        code -= 0x10000;
        out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
      } else {
        out += String.fromCharCode(code);
      }
    }
    return out;
  }

  function decodeUtf8(chunk) {
    if (!chunk || !chunk.length) return '';
    if (typeof TextDecoder !== 'undefined') {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(chunk);
      } catch {
        return '';
      }
    }
    return manualDecodeUtf8(chunk);
  }

  /** Wire type 2: string, bytes, or a nested message already serialised. */
  function fBytes(fieldNumber, payload) {
    const body = toBytes(payload);
    return concat([
      tagField(fieldNumber, WIRE_BYTES),
      new Uint8Array(varintBytes(body.length)),
      body
    ]);
  }

  // ------------------------------------------------------------------ decode

  class Reader {
    constructor(bytes) {
      this.bytes = toBytes(bytes);
      this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
      this.pos = 0;
    }

    get done() {
      return this.pos >= this.bytes.length;
    }

    varint() {
      let result = 0;
      let shift = 0;
      // 64-bit varints from Lens stay within Number's safe range for our fields.
      while (this.pos < this.bytes.length) {
        const byte = this.bytes[this.pos++];
        result += (byte & 0x7f) * Math.pow(2, shift);
        if (!(byte & 0x80)) return result;
        shift += 7;
        if (shift > 63) break;
      }
      throw new Error('truncated varint at offset ' + this.pos);
    }

    /**
     * Iterate top-level fields of this message.
     * @param {(field:number, wire:number, value:number|Uint8Array)=>void} onField
     */
    each(onField) {
      while (!this.done) {
        const key = this.varint();
        const field = key >>> 3;
        const wire = key & 7;

        if (wire === WIRE_VARINT) {
          onField(field, wire, this.varint());
        } else if (wire === WIRE_BYTES) {
          const length = this.varint();
          if (this.pos + length > this.bytes.length) {
            throw new Error('length-delimited field ' + field + ' overruns buffer');
          }
          const chunk = this.bytes.subarray(this.pos, this.pos + length);
          this.pos += length;
          onField(field, wire, chunk);
        } else if (wire === WIRE_FIXED32) {
          onField(field, wire, this.view.getFloat32(this.pos, true));
          this.pos += 4;
        } else if (wire === WIRE_FIXED64) {
          onField(field, wire, this.view.getFloat64(this.pos, true));
          this.pos += 8;
        } else {
          // Wire type 4 (end-group) or 3 (start-group) means we have run past the
          // end of this message's body. Stop rather than emitting garbage.
          return;
        }
      }
    }
  }

  /** Convenience: collect ONLY the first value of each field number. */
  function fieldsMap(bytes) {
    const out = {};
    new Reader(bytes).each((field, wire, value) => {
      if (!(field in out)) out[field] = value;
    });
    return out;
  }

  globalThis.CTProto = {
    Reader,
    fInt,
    fBytes,
    concat,
    varintBytes,
    fieldsMap,
    encodeUtf8,
    decodeUtf8,
    manualDecodeUtf8
  };
}