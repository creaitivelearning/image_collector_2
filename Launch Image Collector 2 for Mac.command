#!/bin/zsh

set -euo pipefail

SCRIPT_DIR="${0:A:h}"
APP_URL="http://localhost:3001"
TERMINAL_COMMAND="cd ${(q)SCRIPT_DIR} && if [[ ! -d node_modules ]]; then npm install; fi && PORT=3001 node src/server.js"

cd "$SCRIPT_DIR"

# Always restart the app server so code changes take effect on launch.
pkill -f "node src/server.js" >/dev/null 2>&1 || true
sleep 0.5

ESCAPED_COMMAND="${TERMINAL_COMMAND//\\/\\\\}"
ESCAPED_COMMAND="${ESCAPED_COMMAND//\"/\\\"}"

osascript <<EOF
tell application "Terminal"
  activate
  do script "$ESCAPED_COMMAND"
end tell
EOF

for _ in {1..40}; do
  if curl -fsS "$APP_URL/health" >/dev/null 2>&1; then
    open "$APP_URL"
    exit 0
  fi

  sleep 0.25
done

echo "Image Collector 2 did not start. Open Terminal to check the server window."
exit 1
