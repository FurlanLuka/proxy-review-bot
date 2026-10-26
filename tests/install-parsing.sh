#!/bin/sh
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PRB_SOURCE_ONLY=1
. "$ROOT/install.sh"

JSON=$(cat "$ROOT/tests/release-fixture.json")

expect() {
    if [ "$1" != "$2" ]; then
        echo "Expected '$2', got '$1'" >&2
        exit 1
    fi
}

expect "$(json_value "$JSON" tag_name)" "v0.2.0"
expect "$(find_asset_url "$JSON" ProxyReviewBot_0.2.0_macos_arm64.zip)" \
    "https://api.github.com/repos/FurlanLuka/proxy-review-bot/releases/assets/2"
expect "$(find_asset_url "$JSON" missing.zip)" ""

echo "install.sh parsing ok"
