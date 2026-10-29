#!/bin/sh
# Runs install.sh's main() the way the app's updater does, on a throwaway folder: stopping,
# starting and the platform checks are stubbed, so the real app and login item are never touched.
set -eu

repository="$(cd "$(dirname "$0")/.." && pwd)"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
app="$work/Applications/ProxyReviewBot.app"

fail() {
    echo "install test: $1" >&2
    exit 1
}

make_zip() {
    bundle="$work/source/$2/ProxyReviewBot.app"
    mkdir -p "$bundle/Contents/MacOS"
    printf '#!/bin/sh\necho "$@" >> "%s/login-item.log"\necho "launch-at-login: enabled"\n' "$work" \
        > "$bundle/Contents/MacOS/ProxyReviewBot"
    chmod +x "$bundle/Contents/MacOS/ProxyReviewBot"
    echo "$2" > "$bundle/Contents/version.txt"
    ditto -c -k --keepParent "$bundle" "$1"
}

# $1: zip, $2: PRB_KEEP_LOGIN_ITEM, $3: which mv to fail (none, swap-out, swap-in)
run_installer() {
    (
        # install.sh runs without -u, as it does for a real install
        set +u
        INSTALL_DIR="$work/Applications"
        PRB_SOURCE_ONLY=1
        PRB_LOCAL_ZIP="$1"
        PRB_KEEP_LOGIN_ITEM="${2:-}"
        PRB_NO_LAUNCH=""
        failing_mv="${3:-none}"
        export INSTALL_DIR PRB_SOURCE_ONLY PRB_LOCAL_ZIP PRB_KEEP_LOGIN_ITEM PRB_NO_LAUNCH
        . "$repository/install.sh"

        check_platform() { :; }
        check_tools() { :; }
        stop_running_app() { echo stopped >> "$work/stop.log"; }
        start_app() { cat "$APP_PATH/Contents/version.txt" >> "$work/start.log"; }

        mv() {
            case "$failing_mv:$2" in
                swap-out:*.old) return 1 ;;
            esac

            case "$failing_mv:$1" in
                swap-in:*.new) return 1 ;;
            esac

            command mv "$@"
        }

        main
    ) > "$work/out.log" 2>&1
}

count() {
    [ -f "$1" ] && grep -c . "$1" || echo 0
}

installed_version() {
    cat "$app/Contents/version.txt"
}

make_zip "$work/v1.zip" v1
make_zip "$work/v2.zip" v2
make_zip "$work/v3.zip" v3
echo "not a zip" > "$work/broken.zip"

run_installer "$work/v1.zip"
[ "$(installed_version)" = "v1" ] || fail "first install missing"
grep -q -- "--launch-at-login-enable" "$work/login-item.log" || fail "a manual install didn't register the login item"
[ "$(cat "$work/start.log")" = "v1" ] || fail "a fresh install didn't start the app exactly once"
echo "install test: a fresh install copies the app, registers the login item and starts it once"

rm -f "$work/login-item.log"
run_installer "$work/v2.zip" 1
[ "$(installed_version)" = "v2" ] || fail "the update didn't replace the app"
[ ! -e "$app.new" ] && [ ! -e "$app.old" ] || fail "a staging copy was left behind"
[ "$(count "$work/stop.log")" -eq 2 ] || fail "the running app wasn't stopped before each swap"
[ ! -e "$work/login-item.log" ] || fail "PRB_KEEP_LOGIN_ITEM still touched the login item"
grep -q "Kept your Launch at login setting." "$work/out.log" || fail "the kept login item wasn't reported"
[ "$(tail -1 "$work/start.log")" = "v2" ] && [ "$(count "$work/start.log")" -eq 2 ] || fail "the update didn't start the new app exactly once"
echo "install test: an update swaps the app in place, starts it once and leaves the login item alone"

set +e
run_installer "$work/broken.zip" 1
broken_status=$?
set -e
[ "$broken_status" -ne 0 ] || fail "a broken zip didn't fail"
[ "$(installed_version)" = "v2" ] || fail "a broken zip removed the app"
[ "$(count "$work/stop.log")" -eq 2 ] || fail "a broken zip stopped the running app"
[ "$(count "$work/start.log")" -eq 2 ] || fail "a broken zip started the app, though it was never stopped"
echo "install test: a broken download fails before the running app is stopped, and starts nothing"

set +e
run_installer "$work/v3.zip" 1 swap-out
swap_out_status=$?
set -e
[ "$swap_out_status" -ne 0 ] || fail "a failed move of the old app didn't fail the install"
[ "$(installed_version)" = "v2" ] || fail "a failed move of the old app lost it"
[ ! -e "$app.new" ] || fail "the staging copy was left behind after a failure"
[ "$(tail -1 "$work/start.log")" = "v2" ] && [ "$(count "$work/start.log")" -eq 3 ] || fail "the stopped app wasn't started again"
grep -q "Starting the app again." "$work/out.log" || fail "the restart wasn't reported"
! grep -q "previous version was put back" "$work/out.log" || fail "reported a put-back that didn't happen"
echo "install test: a failure after the stop starts the app that was running"

set +e
run_installer "$work/v3.zip" 1 swap-in
swap_in_status=$?
set -e
[ "$swap_in_status" -ne 0 ] || fail "a failed move of the new app didn't fail the install"
[ "$(installed_version)" = "v2" ] || fail "the previous version wasn't put back"
[ ! -e "$app.new" ] && [ ! -e "$app.old" ] || fail "a staging copy was left behind after the rollback"
[ "$(tail -1 "$work/start.log")" = "v2" ] && [ "$(count "$work/start.log")" -eq 4 ] || fail "the restored app wasn't started"
grep -q "The install failed, so the previous version was put back." "$work/out.log" || fail "the put-back wasn't reported"
echo "install test: a failure mid-swap puts the previous version back and starts it"

make_zip "$work/v4.zip" v4
command mv "$app" "$app.old"
set +e
run_installer "$work/v4.zip" 1 swap-in
stranded_status=$?
set -e
[ "$stranded_status" -ne 0 ] || fail "the failing swap didn't fail the install"
[ "$(installed_version)" = "v2" ] || fail "a stranded .old copy wasn't put back before the swap"
command mv "$app" "$app.old"
run_installer "$work/v4.zip" 1
[ "$(installed_version)" = "v4" ] || fail "a stranded .old copy blocked the update"
[ ! -e "$app.old" ] && [ ! -e "$app.new" ] || fail "the stranded .old copy was left behind"
[ "$(tail -1 "$work/start.log")" = "v4" ] || fail "the updated app wasn't started"
echo "install test: a stranded .old copy from an interrupted install is restored, then updated"
