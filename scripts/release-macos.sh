#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP_DIR="$ROOT_DIR/apps/desktop"
DIST_DIR="$DESKTOP_DIR/dist"
SIGNING_IDENTITY="${CSC_NAME:-Developer ID Application: Jianliang Wang (BZP4VMX57B)}"

case "${KODY_MAC_ARCH:-$(uname -m)}" in
  arm64) ELECTRON_ARCH="arm64" ;;
  x86_64|x64) ELECTRON_ARCH="x64" ;;
  *) echo "Unsupported macOS architecture: ${KODY_MAC_ARCH:-$(uname -m)}" >&2; exit 1 ;;
esac

command -v asc >/dev/null || { echo "asc is required (brew install asc)" >&2; exit 1; }
security find-identity -v -p codesigning | grep -Fq "$SIGNING_IDENTITY" || {
  echo "Developer ID identity not found: $SIGNING_IDENTITY" >&2
  exit 1
}

cd "$ROOT_DIR"
rm -rf "$DIST_DIR"
npm --workspace @kody/desktop run build:server
npm --workspace @kody/desktop run build
npx --workspace @kody/desktop electron-builder --mac dmg "--$ELECTRON_ARCH" --publish never

APP_PATH="$(find "$DIST_DIR" -maxdepth 3 -type d -name 'Kody.app' -print -quit)"
DMG_PATH="$(find "$DIST_DIR" -maxdepth 1 -type f -name "Kody-*-${ELECTRON_ARCH}.dmg" -print -quit)"
if [[ -z "$APP_PATH" || -z "$DMG_PATH" ]]; then
  echo "Signed Kody.app or DMG was not produced" >&2
  exit 1
fi

codesign --verify --deep --strict --verbose=2 "$APP_PATH"
codesign -dvvv "$APP_PATH" 2>&1 | grep -E 'Authority=Developer ID Application|TeamIdentifier=|Timestamp='

asc notarization submit \
  --file "$DMG_PATH" \
  --wait \
  --poll-interval 15s \
  --timeout 2h \
  --output table

xcrun stapler staple "$DMG_PATH"
xcrun stapler validate "$DMG_PATH"
spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG_PATH"

echo "Release DMG: $DMG_PATH"
