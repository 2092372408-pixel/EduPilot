#!/bin/bash
set -Eeuo pipefail

REPO_ZIP="https://github.com/2092372408-pixel/EduPilot/archive/refs/heads/master.zip"
BUNDLE_ROOT="$(cd "$(dirname "$0")" && pwd -P)"
INSTALL_DIR="${EDUOWL_INSTALL_DIR:-$HOME/EduPilot}"
APP_DIR="$HOME/Applications/EduPilot.app"

die() { echo "EduPilot installation failed: $1" >&2; exit 1; }

copy_bundle() {
  mkdir -p "$INSTALL_DIR"
  for file in .eduowl-bundle .env.example package.json package-lock.json install.command start.command stop.command mcp.servers.json README.md README_en.md LICENSE THIRD_PARTY_NOTICES.md; do
    cp "$BUNDLE_ROOT/$file" "$INSTALL_DIR/$file"
  done
  [[ ! -f "$BUNDLE_ROOT/release-manifest.json" ]] || cp "$BUNDLE_ROOT/release-manifest.json" "$INSTALL_DIR/"
  for dir in server public node_modules runtime docs; do
    [[ -d "$BUNDLE_ROOT/$dir" ]] && rsync -a "$BUNDLE_ROOT/$dir" "$INSTALL_DIR/"
  done
  for source in "$BUNDLE_ROOT"/data/kb/books/python-intro/*.md "$BUNDLE_ROOT"/data/kb/chunks/python-intro/*.json "$BUNDLE_ROOT"/data/kb/index.json "$BUNDLE_ROOT"/data/kb/questions.json; do
    [[ -f "$source" ]] || continue
    file="${source#"$BUNDLE_ROOT"/}"
    mkdir -p "$INSTALL_DIR/$(dirname "$file")"
    cp "$source" "$INSTALL_DIR/$file"
  done
}

if [[ -f "$BUNDLE_ROOT/.eduowl-bundle" ]]; then
  if [[ "$INSTALL_DIR" != "$BUNDLE_ROOT" ]]; then
    if [[ -f "$INSTALL_DIR/package.json" ]] && ! grep -q '"name": "edupilot"' "$INSTALL_DIR/package.json"; then
      die "The install directory contains another project: $INSTALL_DIR"
    fi
    PORT="${PORT:-8787}"
    if [[ -f "$INSTALL_DIR/package.json" ]] && lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      NODE="$INSTALL_DIR/runtime/node"
      [[ -x "$NODE" ]] || NODE="$(command -v node || true)"
      [[ -n "$NODE" && -f "$INSTALL_DIR/.edupilot-instance" ]] || die "Stop the older service on port $PORT before updating."
      response="$(curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
      installed_id="$(<"$INSTALL_DIR/.edupilot-instance")"
      printf '%s' "$response" | "$NODE" -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{try{const h=JSON.parse(s);process.exit(h.ok&&h.installationId===process.argv[1]?0:1)}catch{process.exit(1)}})' "$installed_id" || die "Port $PORT belongs to another installation. Stop it before updating."
      kill "$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN)"
      sleep 1
    fi
    copy_bundle
  fi
elif [[ ! -f "$INSTALL_DIR/package.json" ]]; then
  if [[ -e "$INSTALL_DIR" && -n "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
    die "The install directory is not empty: $INSTALL_DIR"
  fi
  TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/edupilot-install.XXXXXX")"
  trap 'rm -rf "$TMP_ROOT"' EXIT
  echo "Downloading EduPilot..."
  curl -fL --retry 3 --connect-timeout 15 "$REPO_ZIP" -o "$TMP_ROOT/edupilot.zip" || die "Could not download the project archive."
  unzip -q "$TMP_ROOT/edupilot.zip" -d "$TMP_ROOT" || die "Could not extract the project archive."
  SOURCE_DIR="$(find "$TMP_ROOT" -mindepth 1 -maxdepth 1 -type d -name 'EduPilot-*' -print -quit)"
  [[ -n "$SOURCE_DIR" ]] || die "The archive did not contain EduPilot."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  mv "$SOURCE_DIR" "$INSTALL_DIR"
fi

[[ -f "$INSTALL_DIR/package.json" ]] || die "The package is incomplete."
chmod +x "$INSTALL_DIR/start.command" "$INSTALL_DIR/stop.command"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources" "$HOME/Desktop"
printf '#!/bin/bash\n/bin/bash %q > %q 2>&1\nresult=$?\nif (( result != 0 )); then\n  /usr/bin/osascript -e '\''display dialog "EduPilot could not start. See the launch log in the installation folder." buttons {"OK"} default button "OK"'\'' >/dev/null 2>&1 || true\nfi\nexit "$result"\n' \
  "$INSTALL_DIR/start.command" "$INSTALL_DIR/edu-agent-launch.log" > "$APP_DIR/Contents/MacOS/EduPilot"
chmod +x "$APP_DIR/Contents/MacOS/EduPilot"
printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' \
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
  '<plist version="1.0"><dict>' \
  '<key>CFBundleIdentifier</key><string>org.edupilot.local</string>' \
  '<key>CFBundleName</key><string>EduPilot</string>' \
  '<key>CFBundleExecutable</key><string>EduPilot</string>' \
  '<key>CFBundleIconFile</key><string>EduPilot</string>' \
  '<key>CFBundlePackageType</key><string>APPL</string>' \
  '</dict></plist>' > "$APP_DIR/Contents/Info.plist"

ICONSET="$(mktemp -d "${TMPDIR:-/tmp}/edupilot-icon.XXXXXX")"
for size in 16 32 128 256 512; do
  sips -s format png -z "$size" "$size" "$INSTALL_DIR/public/logo-mark.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -s format png -z "$double" "$double" "$INSTALL_DIR/public/logo-mark.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
mv "$ICONSET" "$ICONSET.iconset"
iconutil -c icns "$ICONSET.iconset" -o "$APP_DIR/Contents/Resources/EduPilot.icns"
rm -rf "$ICONSET.iconset"
ln -sfn "$APP_DIR" "$HOME/Desktop/EduPilot.app"
echo "EduPilot is installed. Open it from Desktop or Applications."
/bin/bash "$INSTALL_DIR/start.command" "$@"
