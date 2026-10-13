#!/bin/bash
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd -P)"
PID_FILE="$PROJECT_ROOT/.eduowl.pid"
INSTANCE_FILE="$PROJECT_ROOT/.edupilot-instance"
PORT="${PORT:-8787}"
NODE="$PROJECT_ROOT/runtime/node"
[[ -x "$NODE" ]] || NODE="$(command -v node || true)"
if [[ ! -f "$PID_FILE" || ! -f "$INSTANCE_FILE" || -z "$NODE" ]]; then
  echo "EduPilot is not running from this installation."
  exit 0
fi
PID="$(<"$PID_FILE")"
[[ "$PID" =~ ^[0-9]+$ ]] || { echo "Invalid PID file." >&2; exit 1; }
LISTENER="$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [[ "$LISTENER" != "$PID" ]]; then
  echo "The saved process no longer owns port $PORT; leaving it untouched."
  exit 1
fi
INSTANCE_ID="$(<"$INSTANCE_FILE")"
response="$(curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
if ! printf '%s' "$response" | "$NODE" -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{try{const h=JSON.parse(s);process.exit(h.ok&&h.installationId===process.argv[1]?0:1)}catch{process.exit(1)}})' "$INSTANCE_ID"; then
  echo "Port $PORT belongs to another installation; leaving it untouched." >&2
  exit 1
fi
kill "$PID"
rm -f "$PID_FILE"
echo "EduPilot stopped."
