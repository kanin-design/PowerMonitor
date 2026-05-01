#!/bin/bash

# PowerMonitor Build Script
# Creates a standalone Electron app with proper icon and cleanup

set -e  # Exit on any error

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

echo "=== PowerMonitor Build Script ==="
echo "Building Electron app for macOS (arm64)..."

# Clean previous builds
echo "Cleaning previous builds..."
rm -rf "PowerMonitor-darwin-arm64"
rm -rf "PowerMonitor*.dmg"

# Rebuild native modules for Electron
echo "Rebuilding native modules for Electron..."
npx @electron/rebuild -f -w better-sqlite3

# Ensure macmon binary is present
echo "Copying macmon binary..."
mkdir -p bin
if [ ! -f bin/macmon ]; then
  if [ -f /opt/homebrew/bin/macmon ]; then
    cp /opt/homebrew/bin/macmon bin/macmon
  else
    echo "WARNING: macmon not found — temperature will be unavailable"
  fi
fi
[ -f bin/macmon ] && chmod +x bin/macmon

# Build the app using electron-packager
echo "Building app with electron-packager..."
npx @electron/packager . PowerMonitor \
  --platform=darwin \
  --arch=arm64 \
  --overwrite \
  --prune=true \
  --asar \
  --asar-unpack="**/*.node" \
  --out=./release-builds \
  --app-version=$(node -p "require('./package.json').version") \
  --build-version=$(node -p "require('./package.json').version") \
  --app-bundle-id=com.delfinsoft.powermonitor \
  --app-copyright="$(node -p "require('./package.json').copyright")" \
  --app-category-type=public.app-category.utilities \
  --icon=icons/mac/icon.icns

# Check if build succeeded
if [ ! -d "release-builds/PowerMonitor-darwin-arm64/PowerMonitor.app" ]; then
  echo "ERROR: Build failed - app not found at expected location"
  exit 1
fi

# Move the built app to expected location for backward compatibility
mkdir -p "PowerMonitor-darwin-arm64"
mv "release-builds/PowerMonitor-darwin-arm64/PowerMonitor.app" "PowerMonitor-darwin-arm64/PowerMonitor.app"

# Manually unpack macmon binary (asar-unpack doesn't handle extensionless binaries reliably)
echo "Unpacking macmon binary..."
UNPACKED="PowerMonitor-darwin-arm64/PowerMonitor.app/Contents/Resources/app.asar.unpacked/bin"
mkdir -p "$UNPACKED"
cp "bin/macmon" "$UNPACKED/macmon"
chmod +x "$UNPACKED/macmon"

# Copy icon explicitly (sometimes packager misses it)
echo "Ensuring icon is properly set..."
cp "icons/mac/icon.icns" "PowerMonitor-darwin-arm64/PowerMonitor.app/Contents/Resources/electron.icns"

# Also copy to the app's icon location (some systems look here)
cp "icons/mac/icon.icns" "PowerMonitor-darwin-arm64/PowerMonitor.app/Contents/Resources/PowerMonitor.icns"

# Update CFBundleIconFile in Info.plist to use our custom icon name
echo "Updating Info.plist..."
/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile PowerMonitor" "PowerMonitor-darwin-arm64/PowerMonitor.app/Contents/Info.plist" || \
  echo "Warning: Could not update CFBundleIconFile (may already be correct)"

# Make the app executable
chmod +x "PowerMonitor-darwin-arm64/PowerMonitor.app/Contents/MacOS/PowerMonitor"
chmod +x "PowerMonitor-darwin-arm64/PowerMonitor.app/Contents/Frameworks/*/Helpers/*" 2>/dev/null || true

echo "=== Build Complete ==="
echo "App location: PowerMonitor-darwin-arm64/PowerMonitor.app"
echo "App size: $(du -sh "PowerMonitor-darwin-arm64/PowerMonitor.app" | cut -f1)"
echo ""
echo "To create a distributable DMG, you can run:"
echo "  create-dmg 'PowerMonitor-darwin-arm64/PowerMonitor.app' --volname 'PowerMonitor' --window-pos 200 120 --window-size 800 400 --icon-size 100 --icon 'PowerMonitor.app' 200 190 --hide-extension 'PowerMonitor.app' --app-drop-link 600 185 'PowerMonitor.dmg'"