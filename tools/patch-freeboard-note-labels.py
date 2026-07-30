#!/usr/bin/env python3
"""Patch Freeboard-SK 3.0.1's compiled notes layer to label tide-station notes.

WHY: Freeboard 3.0.1 has a regression -- the <fb-notes> element in
fb-map.component.html is missing the [mapZoom]/[labelMinZoom] bindings every
other resource layer has, so note markers NEVER show their name labels
(updateLabels() is only driven by those inputs). Garmin-style value labels
("2.9ft^ Southport") therefore cannot appear without this patch.

WHAT: rewrites the note buildStyle() in the compiled chunk so that notes
published by signalk-tide-stations bake their name into the marker Text
style (with a white halo). Other plugins' notes are untouched. The proper
fix is an upstream PR adding the two bindings; this patch is the stopgap
for the installed 3.0.1 bundle.

USAGE (on the Signal K host):
  python3 patch-freeboard-note-labels.py            # apply
  python3 patch-freeboard-note-labels.py --revert   # restore backup

Idempotent; keeps a .pre-tide-labels backup next to the chunk.
Re-run after any Freeboard-SK update (chunk names change).
"""
import glob
import os
import re
import shutil
import sys

PUB = os.path.expanduser(
    "~/.signalk/node_modules/@signalk/freeboard-sk/public")

NEEDLE = 'return i?new fe({image:i,text:new Lt({text:"",offsetX:0,offsetY:-12})})'
REPLACEMENT = (
    'return i?new fe({image:i,text:new Lt({'
    'text:t.properties?.plugin==="signalk-tide-stations"&&t.name?String(t.name):"",'
    'offsetX:0,offsetY:-17,font:"bold 11px Roboto,sans-serif",'
    'fill:new Be({color:"#263238"}),'
    'stroke:new xe({color:"#ffffff",width:3})})})'
)


def find_chunk():
    for path in glob.glob(os.path.join(PUB, "*.js")):
        with open(path, encoding="utf-8", errors="ignore") as f:
            body = f.read()
        if NEEDLE in body or REPLACEMENT in body:
            return path, body
    return None, None


def main():
    revert = "--revert" in sys.argv
    path, body = find_chunk()
    if not path:
        sys.exit("notes-layer chunk not found (Freeboard updated? "
                 "re-inspect the bundle for the buildStyle pattern)")
    backup = path + ".pre-tide-labels"
    if revert:
        if os.path.exists(backup):
            shutil.copy2(backup, path)
            print("reverted", path)
        else:
            print("no backup to revert")
        return
    if REPLACEMENT in body:
        print("already patched:", path)
        return
    if not os.path.exists(backup):
        shutil.copy2(path, backup)
    with open(path, "w", encoding="utf-8") as f:
        f.write(body.replace(NEEDLE, REPLACEMENT, 1))
    print("patched", path)


if __name__ == "__main__":
    main()
