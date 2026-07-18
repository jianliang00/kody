#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_ICON="$ROOT_DIR/apps/desktop/build/icon.svg"
OUTPUT_ICON="$ROOT_DIR/apps/desktop/build/icon.icns"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kody-icon.XXXXXX")"
ICONSET_DIR="$TEMP_DIR/Kody.iconset"
MASTER_ICON="$TEMP_DIR/icon-1024.png"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS icon generation requires sips and iconutil."
  exit 1
fi

mkdir -p "$ICONSET_DIR"
sips -s format png "$SOURCE_ICON" --out "$MASTER_ICON" >/dev/null

for logical_size in 16 32 128 256 512; do
  retina_size=$((logical_size * 2))
  sips -z "$logical_size" "$logical_size" "$MASTER_ICON" \
    --out "$ICONSET_DIR/icon_${logical_size}x${logical_size}.png" >/dev/null
  sips -z "$retina_size" "$retina_size" "$MASTER_ICON" \
    --out "$ICONSET_DIR/icon_${logical_size}x${logical_size}@2x.png" >/dev/null
done

iconutil -c icns "$ICONSET_DIR" -o "$OUTPUT_ICON"
echo "Generated $OUTPUT_ICON from $SOURCE_ICON"
