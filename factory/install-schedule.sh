#!/bin/bash
# Installs (or with --remove, removes) a macOS launchd job that runs factory/agent-runner.sh every 15 minutes while
# you are logged in. The runner uses your own `gh`, `qodo` and Claude Code logins; nothing is stored in the repo.
set -euo pipefail

LABEL=dev.scrubline.agent-runner
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SRC=$(cd "$(dirname "$0")/.." && pwd)
WORK=${SCRUBLINE_WORK:-$HOME/.scrubline-factory}
INTERVAL=${INTERVAL:-900}

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
if [ "${1:-}" = "--remove" ]; then
  rm -f "$PLIST"
  echo "removed $LABEL"
  exit 0
fi

# The job runs a copy, so switching branches in this checkout cannot remove the runner from under it. Run this
# script again after changing the runner or its prompts.
mkdir -p "$WORK" "$(dirname "$PLIST")"
rm -rf "$WORK/factory"
cp -R "$SRC/factory" "$WORK/factory"
cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$WORK/factory/agent-runner.sh</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SCRUBLINE_SRC</key><string>$SRC</string>
    <key>SCRUBLINE_WORK</key><string>$WORK</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$WORK/launchd.log</string>
  <key>StandardErrorPath</key><string>$WORK/launchd.log</string>
</dict>
</plist>
EOF
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL: runs $WORK/factory/agent-runner.sh (copied from $SRC) every $INTERVAL s; logs in $WORK"
echo "start a run now: launchctl kickstart gui/$(id -u)/$LABEL"
