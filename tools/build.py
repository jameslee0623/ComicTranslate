#!/usr/bin/env python3
"""
build.py - produce both browser builds from one source tree.

WHY A BUILD STEP EXISTS AT ALL
------------------------------
Chrome and Firefox disagree about `background` in Manifest V3, and they disagree
loudly:

  * Chrome requires `"service_worker"`, and `"scripts"` is not merely ignored -
    it is an unrecognised key in MV3. A manifest carrying both cannot be loaded
    in Chrome.
  * Firefox has no MV3 service-worker support and reads `"scripts"`. It only
    warns about `"service_worker"`, but a warning on every load is noise nobody
    needs.

So the repository root keeps the FIREFOX manifest (that is what
about:debugging#/runtime/this-firefox loads directly, with no build step), and
this script derives the Chrome one. The differences are exactly two keys:

    background                 scripts:[...]   ->  service_worker
    browser_specific_settings  (gecko id)      ->  dropped, plus a
                                                   minimum_chrome_version floor

Everything else - permissions, content scripts, icons, CSP - is identical, which
is why one source manifest is honest rather than a lie.

Usage:
    python3 tools/build.py              # both targets, into dist/
    python3 tools/build.py --chrome     # just dist/chrome
    python3 tools/build.py --firefox    # just dist/firefox
"""

import argparse
import json
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist')

# Copied verbatim into each build. `tools/` is deliberately excluded: the
# verifier is not part of the shipped extension.
INCLUDE = ['manifest.json', '_locales', 'src', 'assets', 'README.md',
           'README.zh-TW.md', 'README.zh-CN.md', 'README.ja.md', 'README.ko.md']

# Chrome flattens `background` to a single service worker. Promise-based MV3
# APIs and storage.session need 102+; 111 is a comfortable floor that costs
# nothing, since nobody runs an extension in a Chrome that old on purpose.
MIN_CHROME_VERSION = '111'


def die(msg):
    print('BUILD FAILED: ' + msg)
    sys.exit(1)


def load_base_manifest():
    path = os.path.join(ROOT, 'manifest.json')
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception as exc:
        die('cannot read manifest.json: %s' % exc)


def check_base_manifest(manifest):
    """Every path the manifest names must exist, in BOTH targets."""
    problems = []

    for size, rel in (manifest.get('icons') or {}).items():
        if not os.path.exists(os.path.join(ROOT, rel)):
            problems.append('icons[%s] -> %s' % (size, rel))

    action = manifest.get('action') or {}
    for size, rel in (action.get('default_icon') or {}).items():
        if not os.path.exists(os.path.join(ROOT, rel)):
            problems.append('action.default_icon[%s] -> %s' % (size, rel))

    for rel in (action.get('default_popup'), (manifest.get('options_ui') or {}).get('page')):
        if rel and not os.path.exists(os.path.join(ROOT, rel)):
            problems.append('page -> %s' % rel)

    background = manifest.get('background') or {}
    for rel in (background.get('scripts') or []):
        if not os.path.exists(os.path.join(ROOT, rel)):
            problems.append('background.scripts -> %s' % rel)
    if background.get('service_worker'):
        if not os.path.exists(os.path.join(ROOT, background['service_worker'])):
            problems.append('background.service_worker -> %s' % background['service_worker'])

    for entry in (manifest.get('content_scripts') or []):
        for rel in (entry.get('js') or []):
            if not os.path.exists(os.path.join(ROOT, rel)):
                problems.append('content_scripts.js -> %s' % rel)

    return problems


def check_import_scripts(manifest):
    """
    Chrome never reads background.scripts - background.js reaches the other
    modules through importScripts() instead. That makes the importScripts list a
    second, independent source of truth, and a module missing from it loads in
    Firefox and is simply absent in Chrome. Resolve every entry.
    """
    background = manifest.get('background') or {}
    rel = background.get('service_worker') or 'src/background/background.js'
    path = os.path.join(ROOT, rel)
    if not os.path.exists(path):
        return ['service worker not found: %s' % rel]

    with open(path) as fh:
        src = fh.read()

    problems = []
    base = os.path.dirname(path)
    for match in re.finditer(r'importScripts\(([^)]*)\)', src):
        for name in re.findall(r"'([^']+)'", match.group(1)):
            if not os.path.exists(os.path.normpath(os.path.join(base, name))):
                problems.append('importScripts -> %s (from %s)' % (name, rel))
    return problems


def chrome_manifest(base):
    """Derive the Chrome manifest: one key swapped, one block dropped."""
    manifest = json.loads(json.dumps(base))          # deep copy, JSON-safe
    background = manifest.get('background') or {}
    worker = background.get('service_worker') or 'src/background/background.js'
    # Replace the whole block: Chrome must not see `scripts` at all.
    manifest['background'] = {'service_worker': worker}
    # Chrome ignores browser_specific_settings; dropping it avoids warnings.
    manifest.pop('browser_specific_settings', None)
    manifest['minimum_chrome_version'] = MIN_CHROME_VERSION
    return manifest


def firefox_manifest(base):
    """The Firefox manifest is the base one, minus the Chrome-only key."""
    manifest = json.loads(json.dumps(base))
    background = dict(manifest.get('background') or {})
    # Firefox has no MV3 service workers and warns about the key.
    background.pop('service_worker', None)
    manifest['background'] = background
    manifest.pop('minimum_chrome_version', None)
    return manifest


def copy_tree(dest):
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    os.makedirs(dest)
    for name in INCLUDE:
        src = os.path.join(ROOT, name)
        if not os.path.exists(src):
            continue
        target = os.path.join(dest, name)
        if os.path.isdir(src):
            shutil.copytree(src, target)
        else:
            shutil.copy2(src, target)


def assert_chrome_safe(manifest, outdir):
    problems = []
    background = manifest.get('background') or {}
    if 'scripts' in background:
        problems.append('Chrome manifest still has background.scripts - MV3 rejects it')
    if not background.get('service_worker'):
        problems.append('Chrome manifest has no background.service_worker')
    if 'browser_specific_settings' in manifest:
        problems.append('Chrome manifest still carries browser_specific_settings')
    if not os.path.exists(os.path.join(outdir, background.get('service_worker') or '')):
        problems.append('service worker file missing from the build output')
    return problems


def assert_firefox_safe(manifest, outdir):
    problems = []
    background = manifest.get('background') or {}
    if 'service_worker' in background:
        problems.append('Firefox manifest still has background.service_worker (unsupported)')
    if not background.get('scripts'):
        problems.append('Firefox manifest has no background.scripts - nothing would load')
    for rel in background.get('scripts') or []:
        if not os.path.exists(os.path.join(outdir, rel)):
            problems.append('background script missing from the build output: %s' % rel)
    return problems


def build(target, base, base_problems):
    outdir = os.path.join(DIST, target)
    manifest = chrome_manifest(base) if target == 'chrome' else firefox_manifest(base)

    copy_tree(outdir)
    with open(os.path.join(outdir, 'manifest.json'), 'w') as fh:
        json.dump(manifest, fh, indent=2)
        fh.write('\n')

    probe = assert_chrome_safe if target == 'chrome' else assert_firefox_safe
    problems = list(base_problems) + probe(manifest, outdir)

    if problems:
        print('  %s: %d PROBLEM(S)' % (target, len(problems)))
        for p in problems:
            print('    - ' + p)
        return False

    count = sum(len(fs) for _, _, fs in os.walk(outdir))
    bg = manifest['background'].get('service_worker') or \
        '%d script(s)' % len(manifest['background']['scripts'])
    print('  %-8s -> %s  (%d files, background: %s)' % (target, outdir, count, bg))
    return True


def main():
    parser = argparse.ArgumentParser(
        description='Build the Firefox and Chrome extensions from one source tree.')
    parser.add_argument('--chrome', action='store_true', help='build only dist/chrome')
    parser.add_argument('--firefox', action='store_true', help='build only dist/firefox')
    args = parser.parse_args()

    both = not (args.chrome or args.firefox)
    targets = [t for t in ('chrome', 'firefox')
               if both or (args.chrome and t == 'chrome') or (args.firefox and t == 'firefox')]

    base = load_base_manifest()
    base_problems = check_base_manifest(base) + check_import_scripts(base)
    if base_problems:
        print('manifest problems shared by both targets:')
        for p in base_problems:
            print('  - ' + p)

    print('source manifest: manifest.json (the Firefox shape)')
    ok = True
    for target in targets:
        ok = build(target, base, base_problems) and ok

    if not ok:
        die('one or more targets would not load')
    print('BUILD OK')
    print('  Firefox: about:debugging#/runtime/this-firefox -> Load Temporary Add-on '
          '-> dist/firefox/manifest.json')
    print('  Chrome:  chrome://extensions -> enable Developer mode -> Load unpacked '
          '-> dist/chrome')


if __name__ == '__main__':
    main()
