#!/bin/bash
# Installs (or with --remove, removes) a macOS launchd job that runs factory/agent-runner.sh every 15 minutes while
# you are logged in. The runner uses your own `gh`, `qodo` and Claude Code logins; nothing is stored in the repo.
set -euo pipefail

LABEL=dev.scrubline.agent-runner
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SRC=$(cd "$(dirname "$0")/.." && pwd)
WORK=${SCRUBLINE_WORK:-$HOME/.scrubline-factory}
INTERVAL=${INTERVAL:-900}

if [ "${1:-}" != "--remove" ]; then
  case "$SRC" in /private/tmp/* | /tmp/* | /private/var/folders/* | /var/folders/*)
    echo "run this from your clone of the repo, not a temporary folder" >&2; exit 1 ;;
  esac
fi
if [ "${1:-}" = "--remove" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed $LABEL"
  exit 0
fi

# The job runs a copy, so switching branches in this checkout cannot remove the runner from under it. Run this
# script again after changing the runner or its prompts. Everything is staged first; the current job is replaced only
# once the new copy and plist are ready, so a failed update leaves the old schedule working.
# Values go into XML.
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

mkdir -p "$WORK" "$(dirname "$PLIST")"
STAGE=$(mktemp -d "$WORK/.install.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
cp -R "$SRC/factory" "$STAGE/factory"
cat >"$STAGE/plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$(xml "$LABEL")</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$(xml "$WORK/factory/agent-runner.sh")</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SCRUBLINE_SRC</key><string>$(xml "$SRC")</string>
    <key>SCRUBLINE_WORK</key><string>$(xml "$WORK")</string>
    <key>HOME</key><string>$(xml "$HOME")</string>
  </dict>
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$(xml "$WORK/launchd.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$WORK/launchd.log")</string>
</dict>
</plist>
EOF
plutil -lint "$STAGE/plist" >/dev/null

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -rf "$WORK/factory.old"
[ -d "$WORK/factory" ] && mv "$WORK/factory" "$WORK/factory.old"
mv "$STAGE/factory" "$WORK/factory"
mv "$STAGE/plist" "$PLIST"
launchctl bootstrap "gui/$(id -u)" "$PLIST"
rm -rf "$WORK/factory.old"
echo "installed $LABEL: runs $WORK/factory/agent-runner.sh (copied from $SRC) every $INTERVAL s; logs in $WORK"
echo "start a run now: launchctl kickstart gui/$(id -u)/$LABEL"
