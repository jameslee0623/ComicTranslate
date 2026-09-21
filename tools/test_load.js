/**
 * Module load smoke test.
 *
 * The bug that motivated this file: lensScrape.js ended with
 *     globalThis.CTLensScrape = Object.assign(globalThis.CTLensScrape, {...});
 * without ever assigning globalThis.CTLensScrape first. That throws at load time
 * on EVERY page, leaving the namespace undefined, so the Lens scrape message
 * failed with "no content-script reply from result tab".
 *
 * It passed the parser check (valid syntax), passed the functional tests (only
 * pure logic was exercised) and passed the semantic check, which had a `continue`
 * for namespaces it could not statically enumerate. So: actually load every
 * module with stubbed browser globals and assert the exported surface exists.
 *
 * Runs under jsc. Run via tools/verify.sh from the repository root.
 */

var noop = function () {};

globalThis.window = globalThis;
globalThis.location = { href: 'https://example.test/page' };
globalThis.navigator = { userAgent: 'jsc-smoke-test' };
globalThis.crypto = { subtle: { digest: function () { return Promise.resolve(new ArrayBuffer(32)); } } };
globalThis.indexedDB = {};
globalThis.TextEncoder = function () { this.encode = function () { return new Uint8Array(0); }; };
globalThis.getComputedStyle = function () { return { position: 'static', backgroundImage: 'none' }; };
globalThis.MutationObserver = function () { this.observe = noop; this.disconnect = noop; };
globalThis.ResizeObserver = function () { this.observe = noop; this.disconnect = noop; };
globalThis.Image = function () {};
globalThis.btoa = function () { return ''; };
if (!globalThis.URL) globalThis.URL = function () {};
if (!globalThis.URL.createObjectURL) globalThis.URL.createObjectURL = function () { return 'blob:x'; };
if (!globalThis.URL.revokeObjectURL) globalThis.URL.revokeObjectURL = noop;

globalThis.document = {
  images: [],
  body: {},
  documentElement: {},
  querySelectorAll: function () { return []; },
  addEventListener: noop,
  removeEventListener: noop,
  createElement: function () {
    return { getContext: function () { return {}; }, style: {}, classList: { add: noop } };
  }
};

globalThis.browser = {
  storage: {
    local: {
      get: function () { return Promise.resolve({}); },
      set: function () { return Promise.resolve(); }
    },
    onChanged: { addListener: noop }
  },
  runtime: {
    onMessage: { addListener: noop },
    onInstalled: { addListener: noop },
    onSuspend: { addListener: noop },
    getManifest: function () { return { version: '0.0.0-test' }; },
    getURL: function (p) { return 'moz-extension://test/' + p; },
    sendMessage: function () {
      return Promise.resolve({ ok: true, data: { settings: { enabled: false }, engines: [] } });
    }
  },
  tabs: {
    create: function () { return Promise.resolve({ id: 1 }); },
    update: function () { return Promise.resolve({ id: 1 }); },
    get: function () { return Promise.resolve({ id: 1 }); },
    query: function () { return Promise.resolve([]); },
    sendMessage: function () { return Promise.resolve({}); },
    remove: function () { return Promise.resolve(); },
    onUpdated: { addListener: noop, removeListener: noop }
  }
};

var BACKGROUND = ['settings.js', 'cache.js', 'imageFetch.js', 'translator.js',
                  'protobuf.js', 'lensProto.js', 'lensEngine.js', 'laraEngine.js',
                  'engines.js', 'background.js'];
var CONTENT = ['textLayout.js', 'painter.js', 'imageScanner.js', 'replaceImage.js',
               'content.js'];

var failures = 0;

function loadAll(dir, files) {
  for (var i = 0; i < files.length; i++) {
    var path = 'src/' + dir + '/' + files[i];
    var src;
    try {
      src = readFile(path);
    } catch (e) {
      print('  FAIL cannot read ' + path);
      failures++;
      continue;
    }
    try {
      // Indirect eval so each file shares the global scope, exactly like content
      // scripts or background scripts sharing one global object.
      (0, eval)(src);
      print('  ok   ' + dir + '/' + files[i]);
    } catch (e) {
      print('  FAIL ' + dir + '/' + files[i] + ' THREW AT LOAD: ' + e.message);
      failures++;
    }
  }
}

print('--- loading background modules ---');
loadAll('background', BACKGROUND);
print('--- loading content modules ---');
loadAll('content', CONTENT);

// --- assert the exported surface exists -------------------------------------
var EXPECTED = {
  CTSettings: ['DEFAULTS', 'load', 'get', 'set', 'onChange', 'isAllowedOn'],
  CTCache: ['makeKey', 'get', 'put', 'prune', 'clear', 'hashBytes'],
  CTImageFetch: ['fetchImageBytes', 'sniffMime', 'normaliseMime', 'measure'],
  CTEngines: ['register', 'get', 'list', 'translateImage', 'normaliseRegion'],
  CTProto: ['Reader', 'fInt', 'fBytes', 'concat', 'varintBytes'],
  CTLensProto: ['scan', 'buildRequest', 'parseResponse', 'regionsFromText',
                'rescaleRegions', 'boxToPixels', 'collectWordsDeep'],
  CTLensEngine: ['imageToRegions', 'toUploadable', 'log'],
  CTLaraEngine: ['authChallenge', 'tokenExpiry', 'tokenIsExpired', 'requireCredentials',
                 'ensureToken', 'imageFormFields', 'extFromMime', 'imageToRegions'],
  CTTranslator: ['parseReply', 'planBatches', 'translateStrings', 'translateRegions'],
  CTTextLayout: ['isRtl', 'tokenize', 'wrapTokens', 'fitText', 'drawText', 'setFont'],
  CTPainter: ['luminance', 'dominantColor', 'sampleRingColor', 'expandBox', 'fillBox',
              'renderRegions'],
  CTImageScanner: ['scan', 'isEligibleUrl', 'markSeen', 'hasSeen', 'reset',
                   'imgCandidate', 'backgroundCandidate'],
  CTReplace: ['apply', 'applyImageBytes', 'restoreElement', 'restoreAll', 'mountOverlay',
              'unmountOverlay', 'canvasToBlobUrl', 'count']
};

print('');
print('--- asserting exported API surface ---');
Object.keys(EXPECTED).forEach(function (ns) {
  var obj = globalThis[ns];
  if (!obj) {
    print('  FAIL ' + ns + ' is UNDEFINED after load (module threw, or export missing)');
    failures++;
    return;
  }
  EXPECTED[ns].forEach(function (member) {
    var value = obj[member];
    if (value === undefined) {
      print('  FAIL ' + ns + '.' + member + ' is undefined');
      failures++;
    } else if (member !== 'DEFAULTS' && typeof value !== 'function') {
      print('  FAIL ' + ns + '.' + member + ' should be a function, got ' + typeof value);
      failures++;
    }
  });
});

// Settings must expose real defaults, not an empty object: the UI writes keys
// that the content script later reads.
var defaults = globalThis.CTSettings && globalThis.CTSettings.DEFAULTS;
if (!defaults || typeof defaults !== 'object') {
  print('  FAIL CTSettings.DEFAULTS is not an object');
  failures++;
} else {
  ['enabled', 'engineId', 'sourceLang', 'targetLang', 'renderMode', 'minImageSize',
   'cacheTtlDays', 'domainMode'].forEach(function (key) {
    if (!(key in defaults)) {
      print('  FAIL CTSettings.DEFAULTS is missing ' + key);
      failures++;
    }
  });
}

print('');
if (failures) {
  print('load: ' + failures + ' FAILURE(S)');
  throw new Error('module load smoke test failed');
}
print('load: every module loaded and exported its API');
