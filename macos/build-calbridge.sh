#!/bin/sh
# Build just the read-only EventKit helper and install it to ~/.gretchen/bin,
# where the Node server (lib/applecal.js) and the CLI both look for it. Run this
# once for the browser/dev-server path; the full app build (build.sh) does it too.
#   macos/build-calbridge.sh
set -e
cd "$(dirname "$0")"
BIN="$HOME/.gretchen/bin"
mkdir -p "$BIN"

echo "· compiling calbridge"
swiftc -O calbridge.swift -o "$BIN/calbridge" -framework EventKit -framework Foundation
# ad-hoc sign so macOS TCC can attribute Calendar access to a stable identity
codesign --force -s - "$BIN/calbridge"
echo "✻ installed $BIN/calbridge"
