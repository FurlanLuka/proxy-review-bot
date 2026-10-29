#!/bin/sh
set -e

# Renders the app icon and builds app/Resources/AppIcon.icns.
# Pass a directory to also write preview PNGs there.

app_directory="$(cd "$(dirname "$0")/.." && pwd)"
work_directory=$(mktemp -d)
trap 'rm -rf "$work_directory"' EXIT

swift "$app_directory/scripts/make-icon.swift" "$work_directory/AppIcon.iconset" ${1:+"$1"}
mkdir -p "$app_directory/Resources"
iconutil -c icns "$work_directory/AppIcon.iconset" -o "$app_directory/Resources/AppIcon.icns"
echo "Wrote $app_directory/Resources/AppIcon.icns"
