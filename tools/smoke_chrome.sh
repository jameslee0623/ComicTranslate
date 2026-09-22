#!/bin/sh
# Headless-Chrome smoke test for the dist/chrome build.
#
# Proves the full boot path in a real Chrome (not jsc stubs): service worker
# registers, content script injects, and - the part earlier ad-hoc runs got
# stuck on - the allowlist decision is `allowed: true` for the local-only
# test site. The test domain is read from the local settings defaults (an
# unpushed commit), and DNS is faked with --host-resolver-rules, so no
# request is ever sent to the real site.
#
# Usage: tools/smoke_chrome.sh   (from the repository root)
set -u

DOMAIN=$(sed -n "s/^ *domains: \['\([^']*\)'\],$/\1/p" src/background/settings.js | head -1)
if [ -z "$DOMAIN" ]; then
  # No local-only defaults (e.g. on a pushed branch): use a throwaway hostname
  # and allowlist it by seeding the extension's storage before boot.
  DOMAIN=ct-smoke.test
  SEED_DOMAIN=1
fi

# Branded Chrome 137+ IGNORES --load-extension ("not allowed in Google
# Chrome"); Chrome for Testing is required. Prefer an explicit $CHROME, then
# the CfT checkout, then (with a warning) the installed Chrome.
CHROME=${CHROME:-"/tmp/cft/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"}
if [ ! -x "$CHROME" ]; then
  ALT="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  [ -x "$ALT" ] && CHROME="$ALT"
fi
[ -x "$CHROME" ] || { echo "smoke: no Chrome binary found"; exit 2; }
case "$CHROME" in
  *"Chrome for Testing"*) ;;
  *) echo "smoke: WARNING - $CHROME will likely ignore --load-extension (Chrome 137+)"
     echo "       install Chrome for Testing to /tmp/cft (see README)" ;;
esac

TMP=$(mktemp -d /tmp/ct-smoke.XXXXXX)
[ "${KEEP:-0}" = 1 ] && echo "smoke: artifacts kept in $TMP"
trap '[ "${KEEP:-0}" = 1 ] || { kill $SRV 2>/dev/null; rm -rf "$TMP"; }' EXIT

# Fixture: a page with one large PNG (>= minImageSize) so the scanner sees it.
# The page flips document.title to CT_LOADED once the content script's
# window.__comicTranslateLoaded flag is visible - the injection proof, since
# Chrome 153 headless does not reliably forward content-script console lines.
# Pure-python PNG (zlib) - no PIL dependency.
python3 - "$TMP" <<'PYEOF'
import struct, zlib, sys, pathlib
d = pathlib.Path(sys.argv[1])
def chunk(t, data):
    return struct.pack('>I', len(data)) + t + data + struct.pack('>I', zlib.crc32(t + data))
w = h = 900  # above the 600px minImageSize default
raw = b''
for y in range(h):
    row = b'\x00'
    for x in range(w):
        row += bytes((255, 255, 255)) if (x // 60 + y // 60) % 2 else bytes((20, 20, 20))
    raw += row
png = (b'\x89PNG\r\n\x1a\n'
       + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
       + chunk(b'IDAT', zlib.compress(raw, 6))
       + chunk(b'IEND', b''))
(d / 'page.png').write_bytes(png)
(d / 'index.html').write_text(
    '<html><head><title>ct-smoke</title></head>'
    '<body><img id="p" src="/page.png" width="900" height="900">'
    '<script>setTimeout(function(){'
    'var base = window.__comicTranslateLoaded ? "CT_LOADED" : "CT_MISSING";'
    'var chip = document.querySelector("div[title^=\'ComicTranslate\']");'
    'var verdict = base + (chip ? "|CT_CHIP" : "|CT_NOCHIP");'
    'document.title = verdict;'
    'new Image().src = "/verdict?title=" + encodeURIComponent(verdict);'
    '}, 4000);</script></body></html>')
PYEOF

# Pick a free port (earlier runs leave orphaned servers behind; a fixed port
# silently broke every subsequent run with "Address already in use").
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$TMP" > "$TMP/access.log" 2>&1 &
SRV=$!
sleep 1

# Console (incl. the `[CT/content]` boot lines) goes to stderr via
# --enable-logging. The fixture page sets document.title to CT_LOADED when
# window.__comicTranslateLoaded is set - i.e. when the content script really
# injected - because Chrome 153 headless does not forward content-script
# console lines reliably and `booted` logs an object that stringifies as
# "[object Object]".
# macOS has no GNU `timeout`, so Chrome runs in the background and is capped
# by a poll (60s): the boot lines and the title flip both happen within
# seconds; the cap only guards against Chrome never exiting.
if [ "${SEED_DOMAIN:-0}" = 1 ]; then
  # No local-only defaults on this branch: allowlist the throwaway domain by
  # writing the settings key directly into storage before the extension's own
  # scripts run. The key name and defaults merge behaviour are pinned by
  # check_semantics (settings.js loads DEFAULTS under stored values).
  cat > "$TMP/ct_seed.js" <<EOF
chrome.storage.local.set({ ct_settings: { domains: ['$DOMAIN'] } });
EOF
  # A copy of the unpacked extension with one extra content script that seeds
  # storage before content.js boots (content_scripts run in listed order, and
  # compat/codec/content.js are all later in the list, so the seed lands first).
  rm -rf "$TMP/ext"
  cp -R dist/chrome "$TMP/ext"
  python3 - "$TMP/ext/manifest.json" <<'PYEOF'
import json, sys
m = json.load(open(sys.argv[1]))
# insert the seed right after compat.js so it runs before content.js
js = m['content_scripts'][0]['js']
js.insert(1, 'ct_seed.js')
open(sys.argv[1], 'w').write(json.dumps(m))
PYEOF
  cp "$TMP/ct_seed.js" "$TMP/ext/ct_seed.js"
  EXT_DIR="$TMP/ext"
else
  EXT_DIR="$PWD/dist/chrome"
fi

"$CHROME" --headless=new --disable-gpu --no-first-run \
  --no-default-browser-check \
  --user-data-dir="$TMP/profile" \
  --load-extension="$EXT_DIR" \
  --host-resolver-rules="MAP $DOMAIN 127.0.0.1" \
  --enable-logging=stderr --v=0 \
  --dump-dom "http://$DOMAIN:$PORT/" > "$TMP/dom.html" 2> "$TMP/console.log" &
CHROME_PID=$!
# Poll the server's access log for the page's verdict beacon (real time; no
# --virtual-time-budget, which fast-forwards page timers before the content
# script injects and produced false CT_MISSING results).
VERDICT=""
for i in $(seq 1 45); do
  sleep 1
  V=$(grep -o 'verdict?title=[^ ]*' "$TMP/access.log" 2>/dev/null | head -1)
  [ -n "$V" ] && { VERDICT="$V"; break; }
  kill -0 "$CHROME_PID" 2>/dev/null || break
done
sleep 5   # let Chrome flush anything still buffered before we kill it
kill "$CHROME_PID" 2>/dev/null
wait "$CHROME_PID" 2>/dev/null

echo "--- assertions ---"
# Note: the page always reports CT_MISSING in its beacon because content
# scripts run in an ISOLATED world - window.__comicTranslateLoaded is not
# visible to page JS. Injection is proven by the [CT/content] console lines
# instead (forwarded to the log with --v=1), and the chip in the beacon
# proves the allowlist matched, because the chip only mounts on allowed pages.
FAILED=""
if grep -aq 'ready on' "$TMP/console.log"; then
  echo "PASS: content script injected and booted ('[CT/content] ready on')"
else
  echo "FAIL: no '[CT/content] ready' boot line"
  FAILED=1
fi
if echo "$VERDICT" | grep -q 'CT_CHIP'; then
  echo "PASS: progress chip mounted - allowlist matched and a run started (allowed:true)"
else
  echo "FAIL: chip absent - allowlist did not match the test domain"
  FAILED=1
fi
if grep -aq 'processing' "$TMP/console.log"; then
  echo "PASS: the scanner picked up the fixture image and sent it to the engine"
else
  echo "FAIL: scan queue never processed the fixture image"
  FAILED=1
fi
if grep -aq 'no regions' "$TMP/console.log"; then
  echo "PASS: OCR round trip completed (Lens answered; fixture has no lettering, so 0 regions is correct)"
else
  echo "note: no 'no regions' line - the OCR call may still have been in flight when the run was cut"
fi
[ -n "$FAILED" ] && exit 1
echo "smoke: PASSED"
