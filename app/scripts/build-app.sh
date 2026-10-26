#!/bin/bash
set -euo pipefail

app_directory="$(cd "$(dirname "$0")/.." && pwd)"
service_source_directory="$(cd "$app_directory/../service" && pwd)"
bun_executable="$(command -v bun || echo "$HOME/.bun/bin/bun")"
version="${VERSION:-0.3.0}"
bundle_directory="$app_directory/build/ProxyReviewBot.app"
contents_directory="$bundle_directory/Contents"
bundled_service_directory="$contents_directory/Resources/service"

cd "$app_directory"

swift build -c release
binary_directory="$(swift build -c release --show-bin-path)"

rm -rf "$bundle_directory"
mkdir -p "$contents_directory/MacOS" "$contents_directory/Resources"
cp "$binary_directory/ProxyReviewBot" "$contents_directory/MacOS/ProxyReviewBot"

cat > "$contents_directory/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>com.furlanluka.proxy-review-bot</string>
	<key>CFBundleName</key>
	<string>Proxy Review Bot</string>
	<key>CFBundleDisplayName</key>
	<string>Proxy Review Bot</string>
	<key>CFBundleExecutable</key>
	<string>ProxyReviewBot</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>$version</string>
	<key>CFBundleVersion</key>
	<string>$version</string>
	<key>LSMinimumSystemVersion</key>
	<string>14.0</string>
	<key>LSUIElement</key>
	<true/>
</dict>
</plist>
PLIST

rsync -a --exclude node_modules --exclude .DS_Store "$service_source_directory/" "$bundled_service_directory/"
(cd "$bundled_service_directory" && "$bun_executable" install --production)

codesign --force --deep -s - "$bundle_directory"

echo "Built $bundle_directory"

if [ -n "${ZIP_OUTPUT:-}" ]; then
	ditto -c -k --keepParent "$bundle_directory" "$ZIP_OUTPUT"
	echo "Zipped $ZIP_OUTPUT"
fi
