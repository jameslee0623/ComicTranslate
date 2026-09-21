/**
 * cache.js - IndexedDB cache for OCR/translation results.
 *
 * Keyed by a hash of (image bytes + engine + languages), so the same panel is
 * never sent to Google twice. Lives in the background context (extension
 * origin), which is the only place with a stable IndexedDB across pages.
 */
'use strict';

if (typeof globalThis.CTCache === 'undefined') {
  const DB_NAME = 'comictranslate';
  const DB_VERSION = 1;
  const STORE = 'translations';
  const SCHEMA_VERSION = 2; // bump to invalidate every cached entry (v2: old
                            // engine cached garbage regions from a dead flow)

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'key' });
          store.createIndex('createdAt', 'createdAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function hashKey(parts) {
    const data = new TextEncoder().encode(parts.join('|'));
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Hash the actual pixels rather than the URL. Comic CDNs reuse URLs with
   * cache-busting query strings, and signed URLs change every page load; the
   * bytes are the only stable identity. We hash a strided sample instead of the
   * whole buffer so a 5 MB webtoon strip does not cost 5 MB of hashing.
   */
  async function hashBytes(buffer) {
    const bytes = new Uint8Array(buffer);
    const SAMPLES = 8192;
    const stride = Math.max(1, Math.floor(bytes.length / SAMPLES));
    const sample = new Uint8Array(Math.ceil(bytes.length / stride));
    let n = 0;
    for (let i = 0; i < bytes.length; i += stride) sample[n++] = bytes[i];
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new Uint8Array([...sample.subarray(0, n)])
    );
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  async function makeKey({ bytes, engineId, sourceLang, targetLang }) {
    const pixelHash = bytes ? await hashBytes(bytes) : 'nobytes';
    return hashKey([SCHEMA_VERSION, engineId, sourceLang, targetLang, pixelHash]);
  }

  async function get(key, ttlDays) {
    if (!key) return null;
    const db = await openDb();
    const row = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    if (!row) return null;
    if (ttlDays > 0) {
      const ageMs = Date.now() - (row.createdAt || 0);
      if (ageMs > ttlDays * 86400000) return null;
    }
    return row.value || null;
  }

  async function put(key, value) {
    if (!key) return;
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ key, value, createdAt: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async function prune(ttlDays) {
    if (!(ttlDays > 0)) return 0;
    const cutoff = Date.now() - ttlDays * 86400000;
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const idx = tx.objectStore(STORE).index('createdAt');
      const req = idx.openCursor(IDBKeyRange.upperBound(cutoff));
      let removed = 0;
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        cursor.delete();
        removed++;
        cursor.continue();
      };
      tx.oncomplete = () => resolve(removed);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function clear() {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  globalThis.CTCache = { makeKey, get, put, prune, clear, hashBytes };
}
