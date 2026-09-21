#!/usr/bin/env bash
#
# verify.sh - offline validation for the ComicTranslate extension.
#
# This machine has no Node/npm, so the extension has no build step and these
# checks substitute for the tooling we would otherwise lean on. Everything here
# runs against the source files directly:
#
#   1. every JS file parses            (JavaScriptCore's parser, via jsc)
#   2. the pure content logic passes   (26 functional assertions, via jsc)
#   3. cross-file references resolve   (manifest paths, element ids, exports)
#
# It does NOT prove the extension works in Firefox. Load it with
# about:debugging and use the options page diagnostics for that.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

JSC="/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc"
FILE_LIST="/tmp/ct-files.json"

failures=0

if [ ! -x "$JSC" ]; then
  echo "jsc not found at $JSC"
  echo "JavaScriptCore ships with macOS. On Linux, use node --check instead."
  exit 2
fi

echo "== 1/5 syntax: parsing every JS file =="
python3 - "$FILE_LIST" <<'PY'
import json, os, sys
out = sys.argv[1]
files = sorted(
    os.path.abspath(os.path.join(dp, f))
    for dp, _, fs in os.walk('src') for f in fs if f.endswith('.js')
)
files += [os.path.abspath('tools/check_syntax.js'),
          os.path.abspath('tools/test_load.js'),
          os.path.abspath('tools/test_pure.js'),
          os.path.abspath('tools/test_lara.js')]
json.dump(files, open(out, 'w'))
print(f"   {len(files)} files queued")
PY
if ! "$JSC" tools/check_syntax.js; then
  failures=$((failures + 1))
fi

echo
echo "== 2/5 load: every module must actually evaluate =="
echo "   (catches runtime errors at load time that a parser cannot see)"
if ! "$JSC" tools/test_load.js; then
  failures=$((failures + 1))
fi

echo
echo "== 3/5 functional: pure content logic =="
if ! "$JSC" tools/test_pure.js; then
  failures=$((failures + 1))
fi

echo
echo "== 4/5 lara: engine auth + request unit tests =="
if ! "$JSC" tools/test_lara.js; then
  failures=$((failures + 1))
fi

echo
echo "== 5/5 semantic: cross-file consistency =="
if ! python3 tools/check_semantics.py; then
  failures=$((failures + 1))
fi

echo
if [ "$failures" -ne 0 ]; then
  echo "VERIFY FAILED ($failures stage(s) failed)"
  exit 1
fi

echo "VERIFY PASSED - remember this is static analysis only."
echo "Next: load manifest.json via about:debugging#/runtime/this-firefox"
