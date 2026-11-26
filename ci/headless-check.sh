#!/usr/bin/env bash
# Boot a headless GNOME Shell on a private session bus, install + enable this
# extension, and assert it reaches ACTIVE state without errors.
#
# Used by CI; also safe to run locally. It never talks to a live desktop
# session's bus, but it does enable the extension in your user settings
# (the same thing `make enable` does).
set -euo pipefail

UUID="gnome-resource-watcher@joel"
WAYLAND_DISPLAY_NAME="rw-ci"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/rw-shell.XXXXXX")"

# Always work on a private session bus: a live desktop shell must never be
# touched, and a fresh bus means the shell re-scans the extensions directory.
if [[ -z "${RW_CI_PRIVATE_BUS:-}" ]]; then
    exec env RW_CI_PRIVATE_BUS=1 dbus-run-session -- "$0" "$@"
fi

# A headless shell expects an XDG_RUNTIME_DIR even without systemd --user.
if [[ -z "${XDG_RUNTIME_DIR:-}" ]]; then
    XDG_RUNTIME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rw-runtime.XXXXXX")"
    export XDG_RUNTIME_DIR
fi

fail() {
    echo "FAIL: $1" >&2
    echo "---- last 60 lines of shell log ----" >&2
    tail -n 60 "$LOG_FILE" >&2 || true
    exit 1
}

make install >/dev/null

gnome-shell --headless --wayland-display="$WAYLAND_DISPLAY_NAME" >"$LOG_FILE" 2>&1 &
SHELL_PID=$!
trap 'kill "$SHELL_PID" 2>/dev/null || true' EXIT

# The shell only scans the extensions directory at startup, so wait until the
# shell is up AND has discovered the extension before touching it.
discovered=""
for _ in $(seq 1 60); do
    kill -0 "$SHELL_PID" 2>/dev/null || fail "gnome-shell exited during startup"
    if gnome-extensions list 2>/dev/null | grep -qx "$UUID"; then
        discovered=1
        break
    fi
    sleep 1
done
[[ -n "$discovered" ]] || fail "shell never discovered $UUID"

gnome-extensions enable "$UUID" || fail "gnome-extensions enable failed"

# Enabling is asynchronous in the shell; poll for ACTIVE state.
state=""
for _ in $(seq 1 30); do
    state="$(gnome-extensions info "$UUID" 2>/dev/null | awk '/State:/ {print $2}')"
    [[ "$state" == "ACTIVE" ]] && break
    sleep 1
done
[[ "$state" == "ACTIVE" ]] || fail "state is '${state:-unknown}', expected ACTIVE"

errors="$(gdbus call --session --dest org.gnome.Shell.Extensions \
    --object-path /org/gnome/Shell/Extensions \
    --method org.gnome.Shell.Extensions.GetExtensionErrors "$UUID")"
[[ "$errors" == "(@as [],)" ]] || fail "extension reported errors: $errors"

# The e.g.o update check logs at plain Message level, so it never matches
# this pattern; anything that does match here is a real problem.
if bad="$(grep -E 'JS ERROR|CRITICAL' "$LOG_FILE")"; then
    printf '%s\n' "$bad" >&2
    fail "JS errors or criticals found in the shell log"
fi

echo "OK: $UUID reached ACTIVE in a headless shell with no errors"
