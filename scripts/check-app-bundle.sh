#!/bin/sh
# The checks the app's updater makes before installing a download, plus the icon. Usage:
# check-app-bundle.sh <ProxyReviewBot.app> [expected version]
set -eu

bundle="$1"
expected_version="${2:-}"
contents="$bundle/Contents"
service="$contents/MacOS/proxy-review-bot-service"

fail() {
    echo "bundle check: $1" >&2
    exit 1
}

plist_value() {
    plutil -extract "$1" raw -o - "$contents/Info.plist"
}

[ "$(plist_value CFBundleIdentifier)" = "com.furlanluka.proxy-review-bot" ] || fail "unexpected bundle id $(plist_value CFBundleIdentifier)"
[ "$(plist_value CFBundleIconFile)" = "AppIcon" ] || fail "Info.plist has no CFBundleIconFile AppIcon"
[ -s "$contents/Resources/AppIcon.icns" ] || fail "the bundle has no AppIcon.icns"
[ -s "$contents/Resources/install.sh" ] || fail "the bundle has no install.sh"
codesign --verify --deep --strict "$bundle" || fail "the bundle's code seal doesn't verify"

bundle_version="$(plist_value CFBundleShortVersionString)"
service_version="$("$service" --version)"

[ "$service_version" = "$bundle_version" ] || fail "the service reports $service_version, the bundle is $bundle_version"
[ -z "$expected_version" ] || [ "$bundle_version" = "$expected_version" ] || fail "the bundle is $bundle_version, expected $expected_version"
echo "bundle check: id, icon, installer and seal ok, and the service reports v$bundle_version"
