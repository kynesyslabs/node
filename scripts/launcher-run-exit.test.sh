#!/usr/bin/env bash
# Stub-based test of the exit status of scripts/run, the bare-metal launcher
# that ./run execs.
#
# The whole launcher runs, from the top through the clean-up after the node
# stops, in a throwaway directory where docker, bun, nc ... are stubs (no
# Docker, no Postgres, no network). The bun stub plays the node; STUB_NODE says
# how it stops:
#   exit:N        the node exits N (1 is a crash or one of its deliberate refusals)
#   int-handled:N Ctrl-C: the launcher and the node both get SIGINT, as from a
#                 terminal; the node handles it and exits N
#   int-killed    Ctrl-C, and the node is killed by the SIGINT (status 130)
# STUB_SETUP=int sends the launcher a Ctrl-C during setup instead: the sleep
# stub signals it at its first sleep (the pause after "Starting your Demos
# Network node"), on a second start where postgres_<port>/ already exists.
#
# Checks:
#   - the node exits 1 -> scripts/run exits 1, after the clean-up
#   - the node exits 3 -> scripts/run exits 3 (the node's own status)
#   - the node exits 0 -> scripts/run exits 0
#   - Ctrl-C (node exits 1, or is killed by the SIGINT) -> "stopped successfully",
#     exit 0, as before
#   - Ctrl-C during setup, then the node exits 1 -> a crash, exit 1 (the
#     setup Ctrl-C does not turn a later crash into a stop)
#   - ./run (the wrapper) -> the node's status too
#
# Usage:
#   scripts/launcher-run-exit.test.sh                 # the scripts next to this file
#   SCRIPTS_DIR=/path/to/old/scripts scripts/launcher-run-exit.test.sh
# Exit status is the number of failed checks (0 = all passed).

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${SCRIPTS_DIR:-$HERE}"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

PASS=0
FAIL=0
N=0

make_stubs() {
    local bin="$1"
    mkdir -p "$bin"

    # `bun run start:bun` is the node; every other bun call succeeds. The
    # launcher is this process's parent (it forks the node and waits for it).
    cat >"$bin/bun" <<'EOF'
#!/usr/bin/env bash
case " $* " in
*" start:bun "*) ;;
*) [[ "${1:-}" == --version ]] && echo 1.0.0; exit 0 ;;
esac
echo "NODE started" >>"$STUB_ST/node.log"
case "$STUB_NODE" in
exit:*) exit "${STUB_NODE#exit:}" ;;
int-handled:*)
    trap 'exit "${STUB_NODE#int-handled:}"' INT
    kill -INT "$PPID" "$$" ;;
int-killed)
    kill -INT "$PPID"
    trap - INT
    kill -INT "$$" ;;
esac
echo "bun stub: STUB_NODE=$STUB_NODE fell through" >&2
exit 99
EOF

    # docker: Postgres is "up" and holds tables, so a plain start only starts the node
    cat >"$bin/docker" <<'EOF'
#!/usr/bin/env bash
case " $* " in
*" psql "*) echo 5 ;;
esac
exit 0
EOF
    printf '#!/usr/bin/env bash\nexit 1\n' >"$bin/lsof"
    printf '#!/usr/bin/env bash\nexit 1\n' >"$bin/ping"
    printf '#!/usr/bin/env bash\nexit 0\n' >"$bin/nc"
    # sleep returns at once; with STUB_SETUP=int its first call sends the
    # launcher (its parent) a SIGINT, which the launcher's INT trap handles
    cat >"$bin/sleep" <<'EOF'
#!/usr/bin/env bash
if [[ "${STUB_SETUP:-}" == int && ! -e "$STUB_ST/setup-int" ]]; then
    : >"$STUB_ST/setup-int"
    kill -INT "$PPID" && echo "SETUP INT (sleep $*)" >>"$STUB_ST/node.log"
fi
exit 0
EOF
    printf '#!/usr/bin/env bash\necho 8\n' >"$bin/nproc"
    chmod +x "$bin"/*
}

new_world() {
    N=$((N + 1))
    W="$ROOT/w$N"
    ST="$W/.stub"
    mkdir -p "$W/scripts" "$W/postgres" "$ST"
    cp "$SRC/run" "$W/scripts/run" || { echo "missing $SRC/run" >&2; exit 99; }
    cp "$SRC/../run" "$W/run" || { echo "missing $SRC/../run" >&2; exit 99; }
    chmod +x "$W/scripts/run" "$W/run"
    : >"$W/postgres/docker-compose.yml"
    printf 'MIN_RAM=0\nSUGGESTED_RAM=0\n' >"$W/.requirements"
    make_stubs "$W/bin"
}

# check NAME STUB_NODE WANT_RC WANT_LINE [LAUNCHER] [STUB_SETUP]
# LAUNCHER is scripts/run (default) or run, relative to the world. timeout also
# gives the launcher a default SIGINT even where this shell ignores it.
# STUB_SETUP=int: Ctrl-C during setup, on a second start (postgres_5332/ exists,
# as the launcher's INT trap cds into it).
check() {
    local name="$1" node="$2" want_rc="$3" want_line="$4" launcher="${5:-scripts/run}"
    local setup="${6:-}"
    local out rc why=""
    new_world
    if [[ "$setup" == int ]]; then
        cp -r "$W/postgres" "$W/postgres_5332"
    fi
    out="$(cd "$W" && env -u PG_PORT -u PG_HOST PATH="$W/bin:$PATH" STUB_ST="$ST" \
        STUB_NODE="$node" STUB_SETUP="$setup" GOSSIP_ENABLED=false \
        timeout 60 "$W/$launcher" -t -m 2>&1)"
    rc=$?
    if ! grep -q 'NODE started' "$ST/node.log" 2>/dev/null; then
        why="the node never started"
    elif [[ "$setup" == int ]] && ! head -1 "$ST/node.log" | grep -q '^SETUP INT'; then
        why="no Ctrl-C reached the launcher before the node started"
    elif [[ "$rc" != "$want_rc" ]]; then
        why="exit $rc (want $want_rc)"
    elif ! grep -qF -- "$want_line" <<<"$out"; then
        why="no \"$want_line\" line"
    elif ! grep -q 'node session completed' <<<"$out"; then
        why="the clean-up after the node did not finish"
    fi
    if [[ -z "$why" ]]; then
        PASS=$((PASS + 1))
        echo "ok   - $name (exit $rc)"
    else
        FAIL=$((FAIL + 1))
        echo "FAIL - $name: $why"
        echo "$out" | tail -8 | sed 's/^/         | /'
    fi
}

CRASH='RPC failed to start or crashed'
echo "# scripts/run exit status (scripts from: $SRC)"
check "node exits 1 -> launcher exits 1" exit:1 1 "$CRASH"
check "node exits 3 -> launcher exits 3" exit:3 3 "$CRASH"
check "node exits 0 -> launcher exits 0" exit:0 0 'node exited successfully'
check "Ctrl-C, node exits 1 -> stopped, exit 0 (unchanged)" int-handled:1 0 'node stopped successfully'
check "Ctrl-C, node killed by SIGINT -> stopped, exit 0 (unchanged)" int-killed 0 'node stopped successfully'
check "Ctrl-C during setup, then node exits 1 -> crash, exit 1" exit:1 1 "$CRASH" scripts/run int
echo "# ./run (execs scripts/run)"
check "./run, node exits 1 -> exits 1" exit:1 1 "$CRASH" run
check "./run, node exits 0 -> exits 0" exit:0 0 'node exited successfully' run

echo
echo "passed $PASS, failed $FAIL"
exit "$FAIL"
