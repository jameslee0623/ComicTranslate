/**
 * compat.js - one namespace for both browsers.
 *
 * Firefox exposes `browser.*`, which is promise-based. Chrome exposes `chrome.*`,
 * which became promise-based for most MV3 APIs but still differs in two ways
 * that matter here:
 *
 *   1. there is no `browser` object at all, so every call site would otherwise
 *      need a `(browser || chrome)` fallback - and one missed site is a runtime
 *      TypeError on the other browser only;
 *   2. `runtime.onMessage` listeners must reply through `sendResponse()` and
 *      return `true`. Returning a Promise - idiomatic and correct in Firefox -
 *      makes Chrome close the port before the reply arrives, which surfaces as
 *      "The message port closed before a response was received."
 *
 * So: alias the namespace here, and use the sendResponse + `return true` reply
 * style everywhere, because Firefox supports that style too.
 *
 * Load this FIRST in every context (background, content script, popup, options).
 */
'use strict';

(function () {
  const native = globalThis.browser;
  const chromeApi = globalThis.chrome;

  // A plain page with neither namespace (a test harness, say): leave it alone.
  if (!native && !chromeApi) {
    globalThis.CTCompat = { isFirefox: false, available: false };
    return;
  }

  if (native) {
    globalThis.CTCompat = { isFirefox: true, available: true, api: native };
    return;
  }

  globalThis.CTCompat = { isFirefox: false, available: true, api: chromeApi };
  // Chrome has no `browser`, so give it one. Its MV3 APIs already return
  // promises when called without a callback, which is all this code relies on.
  globalThis.browser = chromeApi;
})();
