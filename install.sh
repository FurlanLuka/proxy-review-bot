#!/bin/sh
set -e

REPO="FurlanLuka/proxy-review-bot"
APP_NAME="ProxyReviewBot.app"
INSTALL_DIR="${INSTALL_DIR:-$HOME/Applications}"
APP_PATH="$INSTALL_DIR/$APP_NAME"
APP_BINARY="$APP_PATH/Contents/MacOS/ProxyReviewBot"
DATA_DIR="$HOME/Library/Application Support/ProxyReviewBot"
LOG_DIR="$HOME/Library/Logs/ProxyReviewBot"
AGENT_LABEL="com.furlanluka.proxy-review-bot"
AGENT_PLIST="$HOME/Library/LaunchAgents/$AGENT_LABEL.plist"
GUI_DOMAIN="gui/$(id -u)"

say() {
    printf '%s\n' "$1"
}

fail() {
    say "$1"
    exit 1
}

check_platform() {
    [ "$(uname -s)" = "Darwin" ] || fail "Proxy Review Bot only runs on macOS."
    [ "$(uname -m)" = "arm64" ] || fail "Only Apple Silicon (arm64) Macs are supported right now."

    MACOS_MAJOR=$(sw_vers -productVersion | cut -d. -f1)
    [ "$MACOS_MAJOR" -ge 14 ] || fail "macOS 14 or newer is required (found $(sw_vers -productVersion))."
}

stop_running_app() {
    launchctl bootout "$GUI_DOMAIN/$AGENT_LABEL" >/dev/null 2>&1 || true

    if pgrep -x ProxyReviewBot >/dev/null 2>&1; then
        say "Stopping the running app..."
        pkill -x ProxyReviewBot || true
        sleep 2
    fi
}

uninstall() {
    stop_running_app

    if [ -x "$APP_BINARY" ]; then
        "$APP_BINARY" --launch-at-login-disable >/dev/null 2>&1 || true
    fi

    rm -f "$AGENT_PLIST"
    rm -rf "$APP_PATH"
    say "Removed $APP_PATH and its login item."

    if [ "$1" = "--purge" ]; then
        rm -rf "$DATA_DIR" "$LOG_DIR"
        say "Removed settings, database, clones and logs."
    else
        say "Settings, database and logs are kept in: $DATA_DIR"
        say "Run with --uninstall --purge to remove them too."
    fi
}

check_tools() {
    command -v gh >/dev/null 2>&1 || fail "GitHub CLI not found. Install it with: brew install gh, then run: gh auth login"
    command -v git >/dev/null 2>&1 || fail "git not found. Install it with: xcode-select --install"

    if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ]; then
        say "Note: Claude Code isn't installed yet. The app will show how to set it up."
    fi
}

json_value() {
    printf '%s' "$1" | plutil -extract "$2" raw -o - - 2>/dev/null
}

find_asset_url() {
    INDEX=0

    while NAME=$(json_value "$1" "assets.$INDEX.name"); do
        if [ "$NAME" = "$2" ]; then
            json_value "$1" "assets.$INDEX.url"
            return
        fi

        INDEX=$((INDEX + 1))
    done
}

download_release() {
    TOKEN="${GITHUB_TOKEN:-$(gh auth token 2>/dev/null || true)}"
    [ -n "$TOKEN" ] || fail "Not logged in to GitHub. Run: gh auth login"

    RELEASE_JSON=$(curl -fsSL -H "Authorization: Bearer $TOKEN" \
        "https://api.github.com/repos/$REPO/releases/latest") || fail "Could not read the latest release of $REPO."

    VERSION=$(json_value "$RELEASE_JSON" tag_name | sed 's/^v//')
    [ -n "$VERSION" ] || fail "Failed to determine the latest version."

    ASSET_NAME="ProxyReviewBot_${VERSION}_macos_arm64.zip"
    ASSET_URL=$(find_asset_url "$RELEASE_JSON" "$ASSET_NAME")

    [ -n "$ASSET_URL" ] || fail "Release v$VERSION has no $ASSET_NAME."

    say "Downloading Proxy Review Bot v$VERSION..."
    curl -fsSL -H "Authorization: Bearer $TOKEN" -H "Accept: application/octet-stream" \
        "$ASSET_URL" -o "$TMP/app.zip"
}

install_app() {
    TMP=$(mktemp -d)
    trap 'rm -rf "$TMP"' EXIT

    if [ -n "$PRB_LOCAL_ZIP" ]; then
        say "Installing from $PRB_LOCAL_ZIP..."
        cp "$PRB_LOCAL_ZIP" "$TMP/app.zip"
    else
        download_release
    fi

    ditto -x -k "$TMP/app.zip" "$TMP/unpacked"
    [ -d "$TMP/unpacked/$APP_NAME" ] || fail "The download doesn't contain $APP_NAME."

    stop_running_app
    mkdir -p "$INSTALL_DIR"
    rm -rf "$APP_PATH"
    ditto "$TMP/unpacked/$APP_NAME" "$APP_PATH"
    xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null || true
    say "Installed $APP_PATH"
}

enable_login_item() {
    LOGIN_STATUS=$("$APP_BINARY" --launch-at-login-enable 2>&1 || true)

    case "$LOGIN_STATUS" in
        *"launch-at-login: enabled"*)
            say "Starts automatically when you log in, and restarts if it crashes."
            ;;
        *)
            say "Couldn't add the login item ($LOGIN_STATUS). Turn on Launch at login in the app's Settings."
            ;;
    esac
}

start_app() {
    if [ -f "$AGENT_PLIST" ] && launchctl bootstrap "$GUI_DOMAIN" "$AGENT_PLIST" >/dev/null 2>&1; then
        return
    fi

    open "$APP_PATH"
}

main() {
    check_platform

    if [ "$1" = "--uninstall" ]; then
        uninstall "$2"
        exit 0
    fi

    check_tools
    install_app
    enable_login_item

    if [ -n "$PRB_NO_LAUNCH" ]; then
        say "Installed without launching (PRB_NO_LAUNCH is set)."
        exit 0
    fi

    start_app

    say ""
    say "Proxy Review Bot is running. Look for its icon in the menu bar."
    say "It starts in manual mode: nothing is reviewed until you click Review."
    say "If the menu says Setup needed, it lists the command that fixes each item."
}

[ -n "$PRB_SOURCE_ONLY" ] || main "$@"
