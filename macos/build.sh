#!/bin/sh
# Build Gretchen.app — compiles the Swift shell, bundles the web app
# (server.js + lib + public, unchanged) into Resources/app, draws the icon.
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

echo "· bundling web app"
cp "$ROOT/server.js" "$APP/Contents/Resources/app/"
cp -R "$ROOT/lib" "$ROOT/public" "$APP/Contents/Resources/app/"

echo "· drawing icon"
python3 make-icon.py "$APP/Contents/Resources/Gretchen.icns"

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
