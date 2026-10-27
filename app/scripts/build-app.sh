#!/bin/bash
set -euo pipefail

app_directory="$(cd "$(dirname "$0")/.." && pwd)"
service_source_directory="$(cd "$app_directory/../service" && pwd)"
bun_executable="$(command -v bun || echo "$HOME/.bun/bin/bun")"
version="${VERSION:-0.5.0}"
bundle_directory="$app_directory/build/ProxyReviewBot.app"
contents_directory="$bundle_directory/Contents"
service_binary="$contents_directory/MacOS/proxy-review-bot-service"

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

(cd "$service_source_directory" && "$bun_executable" install --frozen-lockfile)
"$bun_executable" build "$service_source_directory/src/entry.ts" \
	--compile \
	--target=bun-darwin-arm64 \
	--minify \
	--sourcemap \
	--no-compile-autoload-dotenv \
	--no-compile-autoload-bunfig \
	--outfile "$service_binary"
rm -f "$service_binary.map"

codesign --force -s - --identifier com.furlanluka.proxy-review-bot.service "$service_binary"
codesign --force -s - "$bundle_directory"

echo "Built $bundle_directory"

if [ -n "${ZIP_OUTPUT:-}" ]; then
	ditto -c -k --keepParent "$bundle_directory" "$ZIP_OUTPUT"
	echo "Zipped $ZIP_OUTPUT"
fi
