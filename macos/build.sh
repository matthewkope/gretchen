#!/bin/sh
# Build Gretchen.app — compiles the Swift shell and links the web app
# (server.js + lib + public) into Resources/app, draws the icon.
#
# Resources/app is *symlinked* to the repo (absolute paths), not copied, so the
# app always runs the live web app: any change to public/, server.js, or lib/
# shows up on the next launch (or ⌘R) with no rebuild. Rebuild only when you
# edit the Swift shell — or move/rename the repo, which breaks the links.
#   macos/build.sh                  → builds macos/Gretchen.app
#   macos/build.sh --install        → also copies it to /Applications
set -e
cd "$(dirname "$0")"
ROOT=$(cd .. && pwd)
APP=Gretchen.app

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"

echo "· compiling shell"
swiftc -O main.swift -o "$APP/Contents/MacOS/Gretchen" -framework Cocoa -framework WebKit

echo "· linking web app (live from the repo)"
ln -s "$ROOT/server.js" "$APP/Contents/Resources/app/server.js"
ln -s "$ROOT/lib" "$APP/Contents/Resources/app/lib"
ln -s "$ROOT/public" "$APP/Contents/Resources/app/public"

echo "· drawing icon"
python3 make-icon.py "$APP/Contents/Resources/Gretchen.icns"

echo "· compiling calbridge (read-only Apple Calendar helper)"
swiftc -O calbridge.swift -o "$APP/Contents/Resources/calbridge" -framework EventKit -framework Foundation
# also install to ~/.gretchen/bin so the browser/dev server and the CLI find it
mkdir -p "$HOME/.gretchen/bin"
cp "$APP/Contents/Resources/calbridge" "$HOME/.gretchen/bin/calbridge"
codesign --force -s - "$HOME/.gretchen/bin/calbridge"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Gretchen</string>
  <key>CFBundleDisplayName</key><string>Gretchen</string>
  <key>CFBundleIdentifier</key><string>com.matthewkope.gretchen</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Gretchen</string>
  <key>CFBundleIconFile</key><string>Gretchen</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSCalendarsUsageDescription</key><string>Gretchen shows your calendar events alongside your tasks. It only reads them — never edits.</string>
  <key>NSCalendarsFullAccessUsageDescription</key><string>Gretchen shows your calendar events alongside your tasks. It only reads them — never edits.</string>
</dict>
</plist>
PLIST

codesign --force --deep -s - "$APP"
echo "✻ built macos/$APP"

if [ "$1" = "--install" ]; then
  rm -rf /Applications/Gretchen.app
  cp -R "$APP" /Applications/
  echo "✻ installed to /Applications/Gretchen.app — drag it to the Dock to pin it"
fi
