/**
 * background.js behaviour tests: page-change cancellation.
 *
 * This is the part of the cancellation feature that cannot live in the engine:
 * the engine aborts ITS request, but what a reader actually notices is the
 * background's routing - a queued request must be dropped rather than sent, the
 * OCR work behind it must not happen, and a stop the extension itself asked for
 * must not be reported to the page as a failure.
 *
 * So background.js is loaded for real, against stubs, and its registered
 * listeners are driven directly. The queue is the real one (serialize), so the
 * ordering these tests exercise is the ordering production has.
 *
 * Runs under jsc via tools/verify.sh from the repository root.
 */

var passed = 0;
var failed = 0;

function check(name, cond, extra) {
  if (cond) { passed++; print('  ok   ' + name); }
  else { failed++; print('  FAIL ' + name + (extra !== undefined ? ' - ' + extra : '')); }
}
function eq(name, actual, expected) {
  var a = String(actual);
  var e = String(expected);
  check(name, a === e, 'got "' + a + '", want "' + e + '"');
}
/** Let the background's promise chain advance. No timers: nothing here waits. */
async function drain() {
  for (var i = 0; i < 20; i++) await Promise.resolve();
}
function deferred() {
  var d = {};
  d.promise = new Promise(function (resolve, reject) {
    d.resolve = resolve;
    d.reject = reject;
  });
  return d;
}
function cancelledError() {
  var e = new Error('Cancelled: the page changed.');
  e.cancelled = true;
  return e;
}

// ── browser stubs, capturing the listeners background.js registers ──────────
var listeners = { message: null, updated: null, removed: null };

globalThis.console = { log: function () {}, warn: function () {}, error: function () {} };
globalThis.browser = {
  storage: {
    local: {
      get: function () { return Promise.resolve({}); },
      set: function () { return Promise.resolve(); }
    },
    onChanged: { addListener: function () {} }
  },
  runtime: {
    onMessage: { addListener: function (fn) { listeners.message = fn; } },
    onInstalled: { addListener: function () {} },
    getManifest: function () { return { version: '0.0.0-test' }; }
  },
  tabs: {
    onUpdated: { addListener: function (fn) { listeners.updated = fn; } },
    onRemoved: { addListener: function (fn) { listeners.removed = fn; } }
  },
  action: { setIcon: function () { return Promise.resolve(); } }
};

// ── the collaborators the router talks to, all recording ────────────────────
var engineCalls = [];
var cancelCalls = 0;
var nextEngineResult = null;

globalThis.CTSettings = {
  get: function () {
    return Promise.resolve({ enabled: true, sourceLang: 'ja', targetLang: 'en' });
  },
  isAllowedOn: function () { return true; }
};
globalThis.CTCache = { prune: function () { return Promise.resolve(0); } };
globalThis.CTCodec = {
  packReply: function (data) { return data; },
  unpackReply: function (data) { return data; }
};
globalThis.CTEngines = {
  translateImage: function (req) {
    engineCalls.push(req);
    return nextEngineResult || Promise.resolve({ regions: [] });
  }
};
// The engine's own half is unit-tested in test_lara.js; here it only has to
// report whether it had something to abort, which is what the router keys on.
globalThis.CTLensLocalEngine = {
  cancelActive: function () { cancelCalls++; return true; }
};

(0, eval)(readFile('src/background/background.js'));
if (!listeners.message || !listeners.updated || !listeners.removed) {
  throw new Error('background.js did not register its listeners');
}

/** Post a message the way a content script does, and await the reply. */
function send(msg, sender) {
  return new Promise(function (resolve) {
    var handled = listeners.message(msg, sender, resolve);
    if (!handled) resolve({ ok: false, error: 'not handled by the router' });
  });
}

var MAIN = { tab: { id: 7 }, frameId: 0, url: 'https://reader.test/page/1' };
var AD = { tab: { id: 7 }, frameId: 5, url: 'https://ad.test/slot' };

async function main() {
  // ── the plain path still works ──────────────────────────────────────────
  var r = await send({ type: 'CT_TRANSLATE_IMAGE', url: 'a.png' }, MAIN);
  eq('background: a translate request reaches the engine', engineCalls.length, 1);
  check('background: and its reply is passed through', r.ok === true && !r.data.skipped);

  // ── a page change drains the queue instead of sending it ────────────────
  // The running job is a local generation nobody will see, and the jobs behind
  // it are images from a document that no longer exists. Both must stop: the
  // running one by abort, the queued ones by never being sent at all.
  var running = deferred();
  nextEngineResult = running.promise;
  var p1 = send({ type: 'CT_TRANSLATE_IMAGE', url: 'b.png' }, MAIN);
  await drain();
  var callsBefore = engineCalls.length;
  var p2 = send({ type: 'CT_TRANSLATE_IMAGE', url: 'c.png' }, MAIN);
  await drain();
  eq('background: the second image waits its turn, unstarted',
     engineCalls.length, callsBefore);

  listeners.updated(7, { status: 'loading' });          // the reader turns the page
  eq('background: the navigation aborts the request in flight', cancelCalls, 1);
  running.reject(cancelledError());                     // the aborted engine reports it

  var reply1 = await p1;
  var reply2 = await p2;
  check('background: the aborted job replies skipped, not failed',
        reply1.ok === true && reply1.data.skipped === true);
  check('background: the skipped reply names the page change',
        reply1.data.reason === 'page changed');
  eq('background: the queued job is dropped, never sent', engineCalls.length, callsBefore);
  check('background: the dropped job reports skipped too',
        reply2.ok === true && reply2.data.skipped === true);

  // ── a genuine failure is still a failure ────────────────────────────────
  var doomed = deferred();
  nextEngineResult = doomed.promise;
  var p3 = send({ type: 'CT_TRANSLATE_IMAGE', url: 'd.png' }, MAIN);
  await drain();
  doomed.reject(new Error('Cannot reach the local server at http://x (timed out after 120s).'));
  var reply3 = await p3;
  check('background: a real engine failure is reported as an error, not skipped',
        reply3.ok === false && /timed out after 120s/.test(reply3.error || ''));

  // ── frame precision: an ad iframe must not kill the page's translation ──
  nextEngineResult = null;
  var inflight = deferred();
  nextEngineResult = inflight.promise;
  var p4 = send({ type: 'CT_TRANSLATE_IMAGE', url: 'e.png' }, MAIN);
  await drain();
  var before = cancelCalls;
  var adReply = await send({ type: 'CT_CANCEL_TRANSLATE' }, AD);
  eq('background: another frame leaving does not abort this frame', cancelCalls, before);
  check('background: and it reports that nothing was cancelled',
        adReply.data.cancelled === false);

  var ownReply = await send({ type: 'CT_CANCEL_TRANSLATE' }, MAIN);
  eq('background: the owning frame does abort its own request', cancelCalls, before + 1);
  check('background: and reports the cancel', ownReply.data.cancelled === true);
  inflight.reject(cancelledError());
  var reply4 = await p4;
  check('background: the frame-cancelled job replies skipped',
        reply4.ok === true && reply4.data.skipped === true);

  // ── a same-document move is not a page change ───────────────────────────
  nextEngineResult = null;
  var keep = deferred();
  nextEngineResult = keep.promise;
  var p5 = send({ type: 'CT_TRANSLATE_IMAGE', url: 'f.png' }, MAIN);
  await drain();
  var before2 = cancelCalls;
  listeners.updated(7, { status: 'complete' });
  listeners.updated(7, { url: 'https://reader.test/page/1#page2' });
  eq('background: a hash change or a completed load cancels nothing',
     cancelCalls, before2);
  keep.resolve({ regions: [{ translated: 'x' }] });
  var reply5 = await p5;
  check('background: the job survives a same-document move',
        reply5.ok === true && !reply5.data.skipped);

  // ── closing the tab, and the id it leaves behind ────────────────────────
  nextEngineResult = null;
  var doomedTab = deferred();
  nextEngineResult = doomedTab.promise;
  var p6 = send({ type: 'CT_TRANSLATE_IMAGE', url: 'g.png' }, MAIN);
  await drain();
  var before3 = cancelCalls;
  listeners.removed(7);
  eq('background: closing the tab aborts its running request', cancelCalls, before3 + 1);
  doomedTab.reject(cancelledError());
  var reply6 = await p6;
  check('background: the closed tab\'s job replies skipped',
        reply6.ok === true && reply6.data.skipped === true);

  // Chrome reuses tab ids. The counters were dropped with the tab, so a fresh
  // tab id must be able to translate immediately - not be told its page changed.
  nextEngineResult = null;
  var reply7 = await send({ type: 'CT_TRANSLATE_IMAGE', url: 'h.png' }, MAIN);
  check('background: a reused tab id starts clean',
        reply7.ok === true && !reply7.data.skipped);

  print('');
  if (failed) {
    print('background: ' + failed + ' FAILURE(S) (' + passed + ' passed)');
    throw new Error('background tests failed');
  }
  print('background: PASSED ' + passed + ', FAILED 0');
}

main().catch(function (e) {
  print('background: test driver failed: ' + (e && e.message));
  throw e;
});
