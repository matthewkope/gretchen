#!/bin/sh
# Keep the Gretchen web app running at http://localhost:5277 at all times.
# Installs a launchd LaunchAgent that starts the node server at login and
# restarts it if it ever exits — so the localhost is always there to open.
#
#   macos/install-server.sh            install + start (port 5277)
#   PORT=8080 macos/install-server.sh  use a different port
#   macos/install-server.sh --uninstall   stop and remove it
set -e

LABEL="com.matthewkope.gretchen-web"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
REPO=$(cd "$(dirname "$0")/.." && pwd)
PORT="${PORT:-5277}"

if [ "$1" = "--uninstall" ]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "✻ stopped and removed the Gretchen server agent"
  exit 0
fi

# launchd has no login PATH, so record the absolute node path now
NODE=$(/bin/zsh -lc 'command -v node')
if [ -z "$NODE" ]; then
  echo "node not found — install Node.js (>=18) first" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.gretchen"

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$REPO/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>$PORT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.gretchen/server.log</string>
  <key>StandardErrorPath</key><string>$HOME/.gretchen/server.log</string>
</dict>
</plist>
PLISTEOF

# reload cleanly whether or not it was already installed
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl enable "$DOMAIN/$LABEL"
launchctl kickstart -k "$DOMAIN/$LABEL"

echo "✻ Gretchen is now always running at http://localhost:$PORT"
echo "  starts at login · restarts if it crashes · log: ~/.gretchen/server.log"
echo "  stop it with: macos/install-server.sh --uninstall"
