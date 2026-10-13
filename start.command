#!/bin/bash
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd -P)"
PORT="${PORT:-8787}"
BASE_URL="http://127.0.0.1:$PORT"
PID_FILE="$PROJECT_ROOT/.eduowl.pid"
INSTANCE_FILE="$PROJECT_ROOT/.edupilot-instance"
STDOUT_LOG="$PROJECT_ROOT/edu-agent-server.log"
STDERR_LOG="$PROJECT_ROOT/edu-agent-server.err.log"
NO_BROWSER="${1:-}"

open_page() {
  if [[ "$NO_BROWSER" != '--no-browser' ]]; then open "$BASE_URL" >/dev/null 2>&1 || true; fi
}

die() { echo "EduPilot could not start: $1" >&2; exit 1; }

if [[ -x "$PROJECT_ROOT/runtime/node" ]]; then
  NODE="$PROJECT_ROOT/runtime/node"
else
  NODE="$(command -v node || true)"
fi
[[ -n "$NODE" ]] || die "Node.js is missing. Use the macOS installer package or install Node.js 22 LTS."
NODE_VERSION="$("$NODE" --version)"
NODE_MAJOR="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] && (( NODE_MAJOR >= 22 )) || die "Node.js 22 or newer is required. Current version: $NODE_VERSION."

if [[ ! -f "$INSTANCE_FILE" ]]; then
  ( set -o noclobber; printf '%s' "$(uuidgen)" > "$INSTANCE_FILE" ) 2>/dev/null || [[ -f "$INSTANCE_FILE" ]]
fi
INSTANCE_ID="$(<"$INSTANCE_FILE")"
ready() {
  local response
  response="$(curl -fsS --max-time 2 "$BASE_URL/api/health" 2>/dev/null)" || return 1
  printf '%s' "$response" | "$NODE" -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{try{const h=JSON.parse(s);process.exit(h.ok&&h.installationId===process.argv[1]?0:1)}catch{process.exit(1)}})' "$INSTANCE_ID"
}

if ready; then
  echo "EduPilot is already running: $BASE_URL"
  open_page
  exit 0
fi
if lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "Port $PORT is in use by another installation or program. Close it before starting this one."
fi

cd "$PROJECT_ROOT"
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env. The app starts in demo mode; configure a real model in Settings."
fi
if [[ ! -d node_modules/better-sqlite3 ]]; then
  command -v npm >/dev/null 2>&1 || die "Dependencies are missing. Download the macOS installer package or install npm."
  npm ci --ignore-scripts || die "Dependency installation failed."
fi
"$NODE" -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.close();" || die "The SQLite native module is unavailable."

EDUPILOT_DESKTOP=1 EDUPILOT_INSTANCE_FILE="$INSTANCE_FILE" nohup "$NODE" server/index.js >>"$STDOUT_LOG" 2>>"$STDERR_LOG" &
child=$!
printf '%s' "$child" > "$PID_FILE"
for ((attempt=0; attempt<30; attempt++)); do
  if ready; then
    echo "EduPilot is ready: $BASE_URL"
    open_page
    exit 0
  fi
  if ! kill -0 "$child" 2>/dev/null; then break; fi
  sleep 1
done
kill "$child" 2>/dev/null || true
rm -f "$PID_FILE"
if [[ -f "$STDERR_LOG" ]]; then tail -n 12 "$STDERR_LOG" >&2 || true; fi
die "The service did not become ready. See $STDERR_LOG."
