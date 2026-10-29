#!/bin/sh
set -eu

binary="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

repository="$work/repo"
tools="$work/tools"
data="$work/data"
calls="$work/calls.log"
marker="$repository/preload-ran"
options_marker="$repository/options-preload-ran"

fail() {
    echo "smoke: $1" >&2
    exit 1
}

bundle="$(dirname "$(dirname "$(dirname "$binary")")")"

case "$bundle" in
    *.app) sh "$(dirname "$0")/check-app-bundle.sh" "$bundle" "${EXPECTED_VERSION:-}" ;;
esac

mkdir -p "$repository" "$tools" "$data"
printf '#!/bin/sh\necho "$@ cwd=$PWD leak=${PRB_LEAK:-}" >> "%s"\nexit 7\n' "$calls" > "$tools/gh"
cp "$tools/gh" "$tools/git"
chmod +x "$tools/gh" "$tools/git"
printf 'PRB_LEAK=from-dotenv\n' > "$repository/.env"
printf 'await Bun.write("%s", "yes");\n' "$marker" > "$repository/pre.ts"
printf 'preload = ["./pre.ts"]\n' > "$repository/bunfig.toml"
printf 'await Bun.write("%s", "yes");\n' "$options_marker" > "$repository/options-pre.ts"
printf 'await Bun.write("%s", process.env.PRB_LEAK ?? "");\n' "$work/probe-leak" > "$repository/probe.ts"
cd "$repository"

if command -v bun > /dev/null 2>&1; then
    bun probe.ts > /dev/null
    [ -e "$marker" ] || fail "fixture control: plain bun did not run the bunfig.toml preload"
    [ "$(cat "$work/probe-leak")" = "from-dotenv" ] || fail "fixture control: plain bun did not load the .env"
    rm -f "$marker"
    BUN_OPTIONS="--preload $repository/options-pre.ts" bun --no-env-file probe.ts > /dev/null
    [ -e "$options_marker" ] || fail "fixture control: plain bun ignored the BUN_OPTIONS preload"
    rm -f "$options_marker" "$marker"
    echo "smoke: fixture control ok (plain bun loads the .env, runs the bunfig.toml and BUN_OPTIONS preloads)"
fi

BUN_OPTIONS="--preload $repository/options-pre.ts" "$binary" --command-shim gh "$tools/gh" api repos/cli/cli > /dev/null 2>&1 || true
[ -e "$options_marker" ] || fail "binary control: the binary ignored BUN_OPTIONS when run directly, so the shim's unset proves nothing"
rm -f "$options_marker"
: > "$calls"
echo "smoke: binary control ok (the binary honours BUN_OPTIONS when run directly; the shim must strip it)"

set +e
"$binary" --command-shim gh "$tools/gh" api -X POST repos/x/y/issues/1/comments 2> "$work/stderr"
write_status=$?
"$binary" --command-shim gh "$tools/gh" api repos/cli/cli
read_status=$?
"$binary" --command-shim gh 2> /dev/null
missing_status=$?
"$binary" --command-shim rm /bin/rm -rf "$work/nothing" 2> /dev/null
unknown_status=$?
set -e

[ "$write_status" -eq 1 ] || fail "write exited $write_status, expected 1"
grep -q "Blocked by proxy-review-bot" "$work/stderr" || fail "write was not reported as blocked"
[ "$read_status" -eq 7 ] || fail "read exited $read_status, expected the real tool's 7"
[ "$missing_status" -eq 2 ] || fail "missing arguments exited $missing_status, expected 2"
[ "$unknown_status" -eq 2 ] || fail "unknown tool exited $unknown_status, expected 2"
[ ! -e "$marker" ] || fail "bunfig.toml preload ran"
echo "smoke: binary blocks writes, forwards reads, rejects bad arguments, ignores .env and bunfig.toml"

: > "$calls"
(cd / && PATH="$tools:/usr/bin:/bin" PRB_DATA_DIR="$data" PRB_LOG_FILE="$work/service.log" "$binary" < /dev/null > "$work/service.out" 2>&1) &
service_pid=$!
waited=0

while kill -0 "$service_pid" 2> /dev/null; do
    [ "$waited" -lt 150 ] || { kill "$service_pid" 2> /dev/null; fail "the service did not exit within 15s of stdin closing"; }
    sleep 0.1
    waited=$((waited + 1))
done
[ -f "$data/bin/gh" ] || fail "the service did not install its command shims"
grep -q "'--command-shim' 'gh'" "$data/bin/gh" || fail "installed gh shim does not use --command-shim"
grep -q "$(basename "$binary")' '--command-shim'" "$data/bin/gh" || fail "installed gh shim does not exec the binary itself"
! grep -q "\.ts'" "$data/bin/gh" || fail "installed gh shim still points at a .ts file"
grep -q '"event":"service_stopping"' "$work/service.log" || fail "the service did not shut down on stdin close"

: > "$calls"
set +e
"$data/bin/gh" pr review 1 --approve 2> "$work/stderr"
shim_write_status=$?
BUN_OPTIONS="--preload $repository/options-pre.ts" NODE_OPTIONS="--require $repository/options-pre.ts" \
    "$data/bin/gh" api repos/cli/cli
shim_read_status=$?
set -e

[ "$shim_write_status" -eq 1 ] || fail "installed shim write exited $shim_write_status, expected 1"
grep -q "Blocked by proxy-review-bot" "$work/stderr" || fail "installed shim write was not reported as blocked"
[ "$shim_read_status" -eq 7 ] || fail "installed shim read exited $shim_read_status, expected 7"
[ "$(cat "$calls")" = "api repos/cli/cli cwd=$repository leak=" ] || fail "unexpected real-tool calls: $(cat "$calls")"
[ ! -e "$marker" ] || fail "bunfig.toml preload ran through the installed shim"
[ ! -e "$options_marker" ] || fail "BUN_OPTIONS preload ran"

echo "smoke: installed shims exec the binary, block writes, forward reads in the repo, ignore .env, bunfig.toml and BUN_OPTIONS (NODE_OPTIONS stripped as hardening)"
