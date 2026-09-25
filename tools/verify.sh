#!/usr/bin/env bash
#
# verify.sh - offline validation for the ComicTranslate extension.
#
# This machine has no Node/npm, so the extension has no build step and these
# checks substitute for the tooling we would otherwise lean on. Everything here
# runs against the source files directly:
#
#   1. every JS file parses            (JavaScriptCore's parser, via jsc)
#   2. every module loads and exports   (stubbed browser globals)
#   3. the pure content logic passes    (via jsc)
#   4. the Lara engine logic passes     (via jsc)
#   5. background routing passes        (cancellation, queue draining)
#   6. cross-file references resolve    (manifest paths, element ids, exports)
#   7. Firefox AND Chrome compatibility (namespace shim, byte transport)
#   8. privacy: local-only test values never appear on any pushed ref
#
# It does NOT prove the extension works in a browser. Load it with
# about:debugging (Firefox) or chrome://extensions (Chrome) and translate a real
# page for that. For Chrome, build first: python3 tools/build.py
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

echo "== 1/8 syntax: parsing every JS file =="
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
          os.path.abspath('tools/test_lara.js'),
          os.path.abspath('tools/test_background.js'),
          os.path.abspath('tools/test_codec.js'),
          os.path.abspath('tools/test_compat.js')]
json.dump(files, open(out, 'w'))
print(f"   {len(files)} files queued")
PY
if ! "$JSC" tools/check_syntax.js; then
  failures=$((failures + 1))
fi

echo
echo "== 2/8 load: every module must actually evaluate =="
echo "   (catches runtime errors at load time that a parser cannot see)"
if ! "$JSC" tools/test_load.js; then
  failures=$((failures + 1))
fi

echo
echo "== 3/8 functional: pure content logic =="
if ! "$JSC" tools/test_pure.js; then
  failures=$((failures + 1))
fi

echo
echo "== 4/8 lara: engine auth + request unit tests =="
if ! "$JSC" tools/test_lara.js; then
  failures=$((failures + 1))
fi

echo
echo "== 5/8 background: page-change cancellation and queue draining =="
if ! "$JSC" tools/test_background.js; then
  failures=$((failures + 1))
fi

echo
echo "== 6/8 semantic: cross-file consistency =="
if ! python3 tools/check_semantics.py; then
  failures=$((failures + 1))
fi
echo "   --- both manifests must be constructible and internally consistent ---"
if python3 tools/build.py > /tmp/ct-build.log 2>&1; then
  grep -E '^  (chrome|firefox)' /tmp/ct-build.log | sed 's/^/   /'
else
  cat /tmp/ct-build.log
  failures=$((failures + 1))
fi

echo
echo "== 7/8 browser: Firefox + Chrome compatibility =="
echo "   (namespace shim, and bytes surviving Chrome's JSON message serialisation)"
if ! "$JSC" tools/test_compat.js; then
  failures=$((failures + 1))
fi
if ! "$JSC" tools/test_codec.js; then
  failures=$((failures + 1))
fi

echo
echo "== 8/8 privacy: local-only test values must never reach origin =="
# Local-only test values (a test language, a test site) exist only as unpushed
# local commits. The values themselves are named in tools/local_only.txt,
# which is gitignored - so this repo's pushed history carries no trace of
# them. This stage fails the moment any declared value appears on any pushed
# ref's tree (tip snapshot; history scrubbing is a one-off manual operation).
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  pat_file=tools/local_only.txt
  if [ ! -f "$pat_file" ]; then
    echo "   note: $pat_file not present - no local-only values declared, skipped"
  else
    leaked=0
    while IFS= read -r pat; do
      [ -z "$pat" ] && continue
      case "$pat" in \#*) continue ;; esac
      for ref in $(git branch -r --format='%(refname)'); do
        if git grep -qI "$pat" "$ref" -- 2>/dev/null; then
          echo "   FAIL: a local-only value ('$pat') is committed on pushed ref $ref"
          echo "   (never push the local-only commit; scrub the source, rebase, re-run)"
          leaked=$((leaked + 1))
        fi
      done
    done < "$pat_file"
    if [ "$leaked" -eq 0 ]; then
      echo "   pushed refs are clean"
    else
      failures=$((failures + 1))
    fi
  fi
else
  echo "   skipped (not a git checkout)"
fi

echo
if [ "$failures" -ne 0 ]; then
  echo "VERIFY FAILED ($failures stage(s) failed)"
  exit 1
fi

echo "VERIFY PASSED - remember this is static analysis only."
echo "Next: load manifest.json via about:debugging#/runtime/this-firefox"
