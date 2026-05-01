#!/usr/bin/env bash
# PowerMonitor build script — macOS arm64
set -euo pipefail

# ── Paths ────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

APP_NAME="PowerMonitor"
BUNDLE_ID="com.delfinsoft.powermonitor"
OUT_DIR="${SCRIPT_DIR}/release-builds"
FINAL_DIR="${SCRIPT_DIR}/${APP_NAME}-darwin-arm64"
APP_BUNDLE="${FINAL_DIR}/${APP_NAME}.app"
CONTENTS="${APP_BUNDLE}/Contents"
RESOURCES="${CONTENTS}/Resources"
PLIST="${CONTENTS}/Info.plist"
ICON_SRC="${SCRIPT_DIR}/icons/mac/icon.icns"
BIN_DIR="${SCRIPT_DIR}/bin"

VERSION="$(node -p "require('./package.json').version")"
COPYRIGHT="$(node -p "require('./package.json').copyright")"

echo "=== PowerMonitor Build v${VERSION} ==="

# ── Validate environment ─────────────────────────────────────────────────────
echo "Validating environment..."

if [ ! -d "${SCRIPT_DIR}/node_modules" ]; then
  echo "ERROR: node_modules not found. Run 'npm install' first."
  exit 1
fi

if [ ! -f "${ICON_SRC}" ]; then
  echo "ERROR: Icon not found at ${ICON_SRC}"
  exit 1
fi

# Locate macmon (try PATH, then common Homebrew locations, then pre-staged)
MACMON_SRC=""
if command -v macmon &>/dev/null; then
  MACMON_SRC="$(command -v macmon)"
elif [ -f /opt/homebrew/bin/macmon ]; then
  MACMON_SRC="/opt/homebrew/bin/macmon"
elif [ -f /usr/local/bin/macmon ]; then
  MACMON_SRC="/usr/local/bin/macmon"
elif [ -f "${BIN_DIR}/macmon" ]; then
  MACMON_SRC="${BIN_DIR}/macmon"
  echo "NOTE: Using pre-staged bin/macmon (macmon not found in PATH)"
fi

if [ -z "${MACMON_SRC}" ]; then
  echo "WARNING: macmon not found — CPU temperature will be unavailable in builds."
  echo "         Install via: brew install macmon"
fi

# ── Clean previous builds ────────────────────────────────────────────────────
echo "Cleaning previous builds..."
rm -rf "${FINAL_DIR}"
rm -rf "${OUT_DIR}"
rm -f  "${SCRIPT_DIR}/${APP_NAME}"*.dmg

# ── Stage macmon binary ──────────────────────────────────────────────────────
if [ -n "${MACMON_SRC}" ]; then
  echo "Staging macmon from ${MACMON_SRC}..."
  mkdir -p "${BIN_DIR}"
  cp "${MACMON_SRC}" "${BIN_DIR}/macmon"
  chmod +x "${BIN_DIR}/macmon"
fi

# ── Rebuild native modules for Electron ─────────────────────────────────────
echo "Rebuilding native modules..."
npx @electron/rebuild -f -w better-sqlite3

# ── Package with electron-packager ──────────────────────────────────────────
echo "Packaging app..."
npx @electron/packager . "${APP_NAME}" \
  --platform=darwin \
  --arch=arm64 \
  --overwrite \
  --prune=true \
  --asar \
  --asar-unpack="**/*.node" \
  --out="${OUT_DIR}" \
  --app-version="${VERSION}" \
  --build-version="${VERSION}" \
  --app-bundle-id="${BUNDLE_ID}" \
  --app-copyright="${COPYRIGHT}" \
  --app-category-type=public.app-category.utilities \
  --icon="${ICON_SRC}"

# ── Validate packager output ─────────────────────────────────────────────────
STAGED_APP="${OUT_DIR}/${APP_NAME}-darwin-arm64/${APP_NAME}.app"
if [ ! -d "${STAGED_APP}" ]; then
  echo "ERROR: Build failed — app not found at ${STAGED_APP}"
  exit 1
fi

# ── Move to final location, clean staging dir ────────────────────────────────
mkdir -p "${FINAL_DIR}"
mv "${STAGED_APP}" "${APP_BUNDLE}"
rm -rf "${OUT_DIR}"

# ── Unpack macmon binary (electron-packager can't unpack extensionless files) ─
if [ -f "${BIN_DIR}/macmon" ]; then
  echo "Unpacking macmon..."
  UNPACKED="${RESOURCES}/app.asar.unpacked/bin"
  mkdir -p "${UNPACKED}"
  cp "${BIN_DIR}/macmon" "${UNPACKED}/macmon"
  chmod +x "${UNPACKED}/macmon"
fi

# ── Set icon ─────────────────────────────────────────────────────────────────
echo "Setting icon..."
cp "${ICON_SRC}" "${RESOURCES}/PowerMonitor.icns"
rm -f "${RESOURCES}/electron.icns"   # remove default Electron icon placeholder

# ── Update Info.plist ────────────────────────────────────────────────────────
echo "Updating Info.plist..."
if [ ! -f "${PLIST}" ]; then
  echo "ERROR: Info.plist not found at ${PLIST}"
  exit 1
fi
/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile PowerMonitor" "${PLIST}"

# ── Set permissions ──────────────────────────────────────────────────────────
chmod +x "${CONTENTS}/MacOS/${APP_NAME}"
while IFS= read -r helper; do
  exe="${helper}/Contents/MacOS/$(basename "${helper}" .app)"
  [ -f "${exe}" ] && chmod +x "${exe}"
done < <(find "${CONTENTS}/Frameworks" -name "*.app" -type d)

# ── Build DMG (if create-dmg is available) ───────────────────────────────────
DMG_NAME="${APP_NAME}-${VERSION}-arm64.dmg"
if command -v create-dmg &>/dev/null; then
  echo "Building DMG..."
  create-dmg \
    --volname "${APP_NAME}" \
    --window-pos 200 120 \
    --window-size 660 400 \
    --icon-size 128 \
    --icon "${APP_NAME}.app" 180 190 \
    --hide-extension "${APP_NAME}.app" \
    --app-drop-link 480 190 \
    "${SCRIPT_DIR}/${DMG_NAME}" \
    "${APP_BUNDLE}"
  echo "DMG: ${DMG_NAME}"
else
  echo "NOTE: create-dmg not found — skipping DMG. Install via: brew install create-dmg"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "=== Build Complete ==="
echo "Version:  ${VERSION}"
echo "Location: ${APP_BUNDLE}"
echo "Size:     $(du -sh "${APP_BUNDLE}" | cut -f1)"
