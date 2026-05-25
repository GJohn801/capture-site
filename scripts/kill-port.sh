#!/bin/sh
# Kill the process listening on the given port, if any.
PORT=${1:-3000}

if command -v lsof >/dev/null 2>&1; then
  PID=$(lsof -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null)
  if [ -n "$PID" ]; then
    echo "Killing process on port $PORT: $PID"
    kill "$PID" 2>/dev/null || kill -9 "$PID" 2>/dev/null
  else
    echo "No process listening on port $PORT"
  fi
else
  echo "lsof is not available; cannot kill port $PORT"
fi
