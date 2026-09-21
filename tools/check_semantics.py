#!/usr/bin/env python3
"""Semantic consistency checks for the ComicTranslate extension.

A parser cannot catch these mistakes, and they otherwise only surface as a
console error at runtime: a file the manifest refers to that does not exist, a
settings key the UI writes that is not in DEFAULTS, or a UI script reaching for
an element id that was renamed in the HTML.

Run via tools/verify.sh, or directly: python3 tools/check_semantics.py
"""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
problems = []


def fail(msg):
    problems.append(msg)
    print("FAIL:", msg)


# 1. paths referenced by the manifest must exist
m = json.load(open("manifest.json"))
refs = list(m["background"]["scripts"]) + [m["background"]["service_worker"]]
refs += m["content_scripts"][0]["js"]
refs += [m["action"]["default_popup"], m["options_ui"]["page"]]
for entry in m.get("web_accessible_resources", []):
    for r in entry["resources"]:
        if "*" not in r:
            refs.append(r)
for r in refs:
    if not os.path.exists(r):
        if r.startswith("assets/") or "*" in r:
            print("note: optional/glob path not present yet:", r)
        else:
            fail("manifest references missing path: " + r)

# 2. HTML asset references must exist (external http(s) links are not assets)
for html in ["src/popup/popup.html", "src/options/options.html"]:
    base = os.path.dirname(html)
    for attr in re.findall(r'(?:src|href)="([^"]+)"', open(html).read()):
        if attr.startswith("http://") or attr.startswith("https://"):
            continue  # external URL, not a bundled asset
        p = os.path.normpath(os.path.join(base, attr))
        if not os.path.exists(p):
            fail(f"{html} references missing asset: {attr}")

# 3. settings keys used by the UI and content script must exist in DEFAULTS
settings_src = open("src/background/settings.js").read()
for key in ["renderMode", "scanBackgrounds", "textStroke", "fontFamily", "minImageSize",
            "maxImagesPerPage", "requestDelayMs", "cacheTtlDays", "domainMode", "domains",
            "debug", "engineId", "sourceLang", "targetLang", "enabled"]:
    if not re.search(r"\b" + key + r"\s*:", settings_src):
        fail("settings.js DEFAULTS is missing key: " + key)

# 4. options.js must only touch ids that exist in options.html
html_ids = set(re.findall(r'id="([^"]+)"', open("src/options/options.html").read()))
options_src = open("src/options/options.js").read()
used = set(re.findall(r"el\('([^']+)'\)", options_src))
used |= set(re.findall(r"getElementById\('([^']+)'\)", options_src))
for block in re.findall(r"(?:FIELDS|CHECKBOXES) = \[([^\]]*)\]", options_src):
    used |= set(re.findall(r"'([^']+)'", block))
for name in sorted(used):
    if name not in html_ids:
        fail("options.js references a missing element id: " + name)

# 5. popup.js must only touch ids that exist in popup.html
popup_ids = set(re.findall(r'id="([^"]+)"', open("src/popup/popup.html").read()))
popup_src = open("src/popup/popup.js").read()
for name in sorted(set(re.findall(r"getElementById\('([^']+)'\)", popup_src))):
    if name not in popup_ids:
        fail("popup.js references a missing element id: " + name)


# 6. every CT* namespace method called from another module must be exported
def exported_keys(body):
    """Split an export object literal into its keys.

    Splitting on commas rather than matching identifiers avoids losing the final
    key, which has no trailing delimiter inside the captured group.
    """
    keys = set()
    for part in body.split(","):
        name = part.strip().split(":")[0].strip()
        if re.fullmatch(r"[A-Za-z_$][\w$]*", name) and name not in ("true", "false"):
            keys.add(name)
    return keys


source_files = [os.path.join(dp, f)
                for dp, _, fs in os.walk("src") for f in fs if f.endswith(".js")]

exports = {}
for path in source_files:
    src = open(path).read()
    for pat in (r"globalThis\.(CT\w+)\s*=\s*\{([^}]*)\}",
                r"Object\.assign\(globalThis\.(CT\w+)\s*,\s*\{([^}]*)\}"):
        for ns, body in re.findall(pat, src):
            exports.setdefault(ns, set()).update(exported_keys(body))
    # Namespaces assembled incrementally still need to be discoverable.
    if re.search(r"Object\.assign\(globalThis\.(CT\w+)", src):
        for ns in re.findall(r"Object\.assign\(globalThis\.(CT\w+)", src):
            exports.setdefault(ns, set())

calls = {}
for path in source_files:
    src = open(path).read()
    for ns, method in re.findall(r"\b(CT[A-Z]\w+)\.(\w+)\s*\(", src):
        calls.setdefault((ns, method), set()).add(os.path.basename(path))

for (ns, method), where in sorted(calls.items()):
    known = exports.get(ns)
    if known is None or not known:
        continue  # namespace not statically enumerable; checked by hand
    if method not in known:
        fail(f"{sorted(where)} calls {ns}.{method}() which {ns} does not export")

# 7. every module on disk must be wired into a runtime load path.
#    The bug this catches: lensProto.js existed and passed every test, but was
#    absent from manifest background.scripts and from importScripts, so the real
#    background page never defined CTLensProto and every scan died with
#    "CTLensProto is not defined". Tests eval modules by hand, so they hide
#    exactly this class of mistake.
bg_scripts = [os.path.basename(p) for p in m["background"]["scripts"]]
imported = set()
for chunk in re.findall(r"importScripts\(([^)]*)\)",
                        open("src/background/background.js").read()):
    imported |= set(re.findall(r"'([^']+)'", chunk))
for f in sorted(os.listdir("src/background")):
    if not f.endswith(".js") or f == "background.js":
        continue  # the entry point loads itself
    if f not in bg_scripts:
        fail(f"src/background/{f} is not in manifest background.scripts "
             f"(Firefox event page never loads it)")
    if f not in imported:
        fail(f"src/background/{f} is missing from background.js importScripts "
             f"(Chrome service worker never loads it)")

cs_files = set()
for entry in m["content_scripts"]:
    cs_files |= {os.path.basename(p) for p in entry["js"]}
for f in sorted(os.listdir("src/content")):
    if f.endswith(".js") and f not in cs_files:
        fail(f"src/content/{f} is not in manifest content_scripts (never loads)")

print()
if problems:
    print("semantic: " + str(len(problems)) + " PROBLEM(S) FOUND")
    raise SystemExit(1)
print("semantic: all consistency checks passed")
