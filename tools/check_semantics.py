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
# The root manifest is the FIREFOX shape (background.scripts). The Chrome shape
# is derived by tools/build.py, which asserts its own invariants; see check 8.
refs = list(m["background"].get("scripts") or [])
if m["background"].get("service_worker"):
    refs.append(m["background"]["service_worker"])
refs += m["content_scripts"][0]["js"]
refs += [m["action"]["default_popup"], m["options_ui"]["page"]]
for p in (m.get("icons") or {}).values():
    refs.append(p)
for p in ((m.get("action") or {}).get("default_icon") or {}).values():
    refs.append(p)
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
            "debug", "engineId", "sourceLang", "targetLang", "enabled",
            "laraAccessKeyId", "laraAccessKeySecret", "laraModel", "laraMonthlyCap",
            "localTextUrl", "localTextApiKey"]:
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

# 8. cross-browser: compat.js must be the FIRST script in every context.
#    It is what gives Chrome a `browser` namespace. If it loads after a module
#    that touches `browser.*` while evaluating, that module throws - on Chrome
#    only, which is the worst possible failure mode.
for label, files in (("manifest background.scripts", m["background"].get("scripts") or []),
                     ("manifest content_scripts js", m["content_scripts"][0]["js"])):
    if not files or os.path.basename(files[0]) != "compat.js":
        first = files[0] if files else "nothing"
        fail(f"{label} must load src/shared/compat.js first (got {first})")

# 8b. the popup's on-demand injection (the "Receiving end does not exist"
#     self-heal) must list EXACTLY the manifest's content-script files in the
#     same order. The load order is a hard dependency: compat/codec first,
#     orchestrator last. If the manifest gains a file and popup.js does not,
#     healed tabs run a different (broken) program than fresh ones.
heal = re.search(r"async function healTab\(tabId\) \{.*?const files = \[(.*?)\];",
                 open("src/popup/popup.js").read(), re.S)
if not heal:
    fail("popup.js is missing the healTab() injection list (self-heal broken)")
else:
    heal_files = re.findall(r"'([^']+\.js)'", heal.group(1))
    manifest_cs = m["content_scripts"][0]["js"]
    if heal_files != manifest_cs:
        fail("healTab() files differ from manifest content_scripts - healed tabs "
             f"would run a different program: heal={heal_files} manifest={manifest_cs}")

for html in ["src/popup/popup.html", "src/options/options.html"]:
    scripts = re.findall(r'<script src="([^"]+)"', open(html).read())
    if not scripts or os.path.basename(scripts[0]) != "compat.js":
        first = scripts[0] if scripts else "no scripts"
        fail(f"{html} must load shared/compat.js first (got {first})")

# 9. Chrome runs the background as a SERVICE WORKER, which has no DOM at all.
#    A bare `document.`/`window.` there is a ReferenceError on Chrome and works
#    perfectly on Firefox - so it has to be behind a typeof guard.
DOM_TOKENS = ("document.", "window.", "getComputedStyle", "MutationObserver")
for name in sorted(os.listdir("src/background")):
    if not name.endswith(".js"):
        continue
    path = os.path.join("src/background", name)
    src = open(path).read()
    if any(tok in src for tok in DOM_TOKENS):
        if "typeof document" not in src and "typeof window" not in src:
            fail(f"{path} uses DOM APIs with no typeof guard - Chrome's service "
                 f"worker has no DOM")

# 10. The message reply style has to be sendResponse + `return true`.
#     Firefox accepts a returned Promise; Chrome does not, and closes the port
#     instead, which surfaces as "The message port closed before a response was
#     received" - an error that says nothing about the real cause.
for path, tag in (("src/background/background.js", "background"),
                  ("src/content/content.js", "content script")):
    src = open(path).read()
    if "onMessage.addListener" not in src:
        fail(f"{path} has no runtime.onMessage listener")
        continue
    if "sendResponse" not in src:
        fail(f"{tag} onMessage listener must reply via sendResponse for Chrome")
    if not re.search(r"return true;", src):
        fail(f"{tag} onMessage listener must `return true` for Chrome")

print()
if problems:
    print("semantic: " + str(len(problems)) + " PROBLEM(S) FOUND")
    raise SystemExit(1)
print("semantic: all consistency checks passed")