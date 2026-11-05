#!/usr/bin/env bash
# Stub-based test of the launchers' wipe-then-migrate guards (G16-a, F1).
#
# The node no longer migrates at boot, so the launchers create the schema after
# they empty the database. That must never reach a database that was NOT
# emptied. docker, bun, nc, rm, sudo ... are stubbed (no Docker, no Postgres, no
# network): the stub "database" is a directory of table files, and every
# `migration:run` is recorded in migrate.log.
#
# Checks, for scripts/docker-run --clean, scripts/run -c true / -b true and
# scripts/wipe-and-reboot.sh:
#   - a failed stack teardown or a failed removal of the volume / data dir stops
#     the launcher before migrate
#   - a database that still has tables stops it before migrate
#   - an empty database is migrated exactly once
#   - a plain start never migrates
#
# Usage:
#   scripts/launcher-wipe-guard.test.sh                 # the scripts next to this file
#   SCRIPTS_DIR=/path/to/old/scripts scripts/launcher-wipe-guard.test.sh
#                                                       # another copy (e.g. a pre-fix checkout)
# Exit status is the number of failed checks (0 = all passed).

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${SCRIPTS_DIR:-$HERE}"
REAL_RM="$(command -v rm)"
ROOT="$(mktemp -d)"
trap '"$REAL_RM" -rf "$ROOT"' EXIT

PASS=0
FAIL=0
N=0

# -----------------------------------------------------------------------------
# Stubs
# -----------------------------------------------------------------------------
make_stubs() {
    local bin="$1"
    mkdir -p "$bin"

    cat >"$bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >>"$STUB_ST/calls.log"
count() { local n; n="$(ls -1 "$1" 2>/dev/null | wc -l)"; echo $((n)); }
case "${1:-}" in
compose)
    sub=""
    for a in "$@"; do
        case "$a" in down|up|run|exec|version|build|logs) sub="$a"; break ;; esac
    done
    case "$sub" in
    down) [[ "${STUB_FAIL_DOWN:-0}" == 1 ]] && { echo "Error: cannot stop" >&2; exit 1; }; exit 0 ;;
    up)
        if [[ "$(basename "$PWD")" == postgres_* ]]; then
            mkdir -p "data_${PG_PORT:-5332}/postgres/tables"
        else
            mkdir -p "$STUB_ST/vol/demos_pgdata/tables"
        fi
        exit 0 ;;
    exec)
        [[ "${STUB_FAIL_PSQL:-0}" == 1 ]] && exit 1
        if [[ -n "${STUB_PSQL_TABLES:-}" ]]; then echo "$STUB_PSQL_TABLES"; exit 0; fi
        count "$STUB_ST/vol/demos_pgdata/tables"
        exit 0 ;;
    run)
        case " $* " in
        *" migration:run "*)
            echo MIGRATE >>"$STUB_ST/migrate.log"
            mkdir -p "$STUB_ST/vol/demos_pgdata/tables"
            touch "$STUB_ST/vol/demos_pgdata/tables/migrations" ;;
        esac
        exit 0 ;;
    logs) echo "GENESIS ok"; exit 0 ;;
    *) exit 0 ;;
    esac ;;
volume)
    case "${2:-}" in
    inspect) [[ -d "$STUB_ST/vol/$3" ]]; exit $? ;;
    create) mkdir -p "$STUB_ST/vol/$3"; exit 0 ;;
    ls) ls -1 "$STUB_ST/vol" 2>/dev/null; exit 0 ;;
    rm)
        [[ "${STUB_FAIL_VOLRM:-0}" == 1 ]] && { echo "Error: volume $3 is in use" >&2; exit 1; }
        "$STUB_REAL_RM" -rf "$STUB_ST/vol/$3"
        exit 0 ;;
    esac
    exit 0 ;;
exec)
    case "${3:-}" in
    pg_isready) exit 0 ;;
    psql)
        [[ "${STUB_FAIL_PSQL:-0}" == 1 ]] && exit 1
        if [[ -n "${STUB_PSQL_TABLES:-}" ]]; then echo "$STUB_PSQL_TABLES"; exit 0; fi
        count "$STUB_WORK/postgres_5332/data_5332/postgres/tables"
        exit 0 ;;
    esac
    exit 0 ;;
*) exit 0 ;;
esac
EOF

    cat >"$bin/bun" <<'EOF'
#!/usr/bin/env bash
echo "bun $*" >>"$STUB_ST/calls.log"
case "${1:-}" in
--version) echo 1.0.0 ;;
run)
    case "${2:-}" in
    migration:run)
        echo MIGRATE >>"$STUB_ST/migrate.log"
        d="$STUB_WORK/postgres_${PG_PORT:-5332}/data_${PG_PORT:-5332}/postgres/tables"
        mkdir -p "$d"
        touch "$d/migrations" ;;
    esac ;;
esac
exit 0
EOF

    # rm that refuses to touch a data_* directory when STUB_FAIL_RM=1
    cat >"$bin/rm" <<'EOF'
#!/usr/bin/env bash
if [[ "${STUB_FAIL_RM:-0}" == 1 ]]; then
    for a in "$@"; do
        case "$a" in data_*) echo "rm: cannot remove '$a': Permission denied" >&2; exit 1 ;; esac
    done
fi
exec "$STUB_REAL_RM" "$@"
EOF

    printf '#!/usr/bin/env bash\nexit 1\n' >"$bin/sudo"
    printf '#!/usr/bin/env bash\nexit 1\n' >"$bin/lsof"
    printf '#!/usr/bin/env bash\nexit 1\n' >"$bin/ping"
    printf '#!/usr/bin/env bash\nexit 0\n' >"$bin/nc"
    printf '#!/usr/bin/env bash\nexit 0\n' >"$bin/sleep"
    printf '#!/usr/bin/env bash\necho 8\n' >"$bin/nproc"
    chmod +x "$bin"/*
}

# -----------------------------------------------------------------------------
# World: a throwaway checkout root with the scripts under test and the stubs
# -----------------------------------------------------------------------------
new_world() {
    W="$ROOT/w$N"
    ST="$W/.stub"
    mkdir -p "$W/scripts" "$W/postgres" "$ST/vol"
    for f in docker-run run wipe-and-reboot.sh; do
        cp "$SRC/$f" "$W/scripts/$f" || { echo "missing $SRC/$f" >&2; exit 99; }
        chmod +x "$W/scripts/$f"
    done
    : >"$W/docker-compose.yml"
    : >"$W/postgres/docker-compose.yml"
    printf 'MIN_RAM=0\nSUGGESTED_RAM=0\n' >"$W/.requirements"
    make_stubs "$W/bin"
}

# the Docker volumes hold a live database
seed_volumes() {
    mkdir -p "$ST/vol/demos_pgdata/tables" "$ST/vol/demos_node_data" "$ST/vol/demos_node_state"
    touch "$ST/vol/demos_pgdata/tables/users" "$ST/vol/demos_pgdata/tables/blocks"
}

# the bare-metal bind-mounted data dir holds a live database
seed_datadir() {
    mkdir -p "$W/postgres_5332/data_5332/postgres/tables"
    : >"$W/postgres_5332/docker-compose.yml"
    touch "$W/postgres_5332/data_5332/postgres/tables/users" "$W/postgres_5332/data_5332/postgres/tables/blocks"
}

migrations() {
    if [[ -f "$ST/migrate.log" ]]; then grep -c MIGRATE "$ST/migrate.log" || true; else echo 0; fi
}

# check NAME EXPECT_RC EXPECT_MIGRATIONS CMD...   (EXPECT_RC: ok | fail)
# env for the run comes from the caller's exported STUB_* variables
check() {
    local name="$1" want_rc="$2" want_mig="$3"
    shift 3
    local out rc mig ok=1
    out="$(cd "$W" && env PATH="$W/bin:$PATH" STUB_ST="$ST" STUB_WORK="$W" STUB_REAL_RM="$REAL_RM" \
        GOSSIP_ENABLED=false timeout 60 "$@" 2>&1)"
    rc=$?
    mig="$(migrations)"
    [[ "$want_rc" == ok && "$rc" -ne 0 ]] && ok=0
    [[ "$want_rc" == fail && "$rc" -eq 0 ]] && ok=0
    [[ "$mig" -ne "$want_mig" ]] && ok=0
    if [[ "$ok" -eq 1 ]]; then
        PASS=$((PASS + 1))
        echo "ok   - $name (exit $rc, migrations $mig)"
    else
        FAIL=$((FAIL + 1))
        echo "FAIL - $name: exit $rc (want $want_rc), migrations $mig (want $want_mig)"
        echo "$out" | tail -8 | sed 's/^/         | /'
    fi
    LAST_OUT="$out"
}

start_case() { N=$((N + 1)); unset STUB_FAIL_DOWN STUB_FAIL_VOLRM STUB_FAIL_RM STUB_FAIL_PSQL STUB_PSQL_TABLES; new_world; }

# -----------------------------------------------------------------------------
# docker-run
# -----------------------------------------------------------------------------
echo "# scripts/docker-run (scripts from: $SRC)"

start_case; seed_volumes; export STUB_FAIL_VOLRM=1
check "docker-run --clean: volume removal fails -> stops before migrate" fail 0 "$W/scripts/docker-run" --clean up -d
[[ -d "$ST/vol/demos_pgdata/tables" ]] || { FAIL=$((FAIL + 1)); echo "FAIL - volume demos_pgdata vanished"; }

start_case; seed_volumes; export STUB_FAIL_DOWN=1
check "docker-run --clean: stack teardown fails -> stops before migrate" fail 0 "$W/scripts/docker-run" --clean up -d

start_case; seed_volumes; export STUB_PSQL_TABLES=2
check "docker-run --clean: database not empty after the wipe -> stops before migrate" fail 0 "$W/scripts/docker-run" --clean up -d
case "$LAST_OUT" in *"still has 2 table"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - no plain 'not empty' message"; esac

start_case; seed_volumes; export STUB_FAIL_PSQL=1
check "docker-run --clean: emptiness cannot be checked -> stops before migrate" fail 0 "$W/scripts/docker-run" --clean up -d

start_case; seed_volumes
check "docker-run --clean: empty database -> migrates once" ok 1 "$W/scripts/docker-run" --clean up -d

start_case; seed_volumes
check "docker-run up -d (no --clean) on a populated database -> never migrates" ok 0 "$W/scripts/docker-run" up -d

# -----------------------------------------------------------------------------
# scripts/run
# -----------------------------------------------------------------------------
echo "# scripts/run (scripts from: $SRC)"

start_case; seed_datadir; export STUB_FAIL_RM=1
check "run -c true: data dir removal fails -> stops before migrate" fail 0 "$W/scripts/run" -c true -t -m

start_case; seed_datadir; export STUB_FAIL_DOWN=1
check "run -c true: container stop fails -> stops before migrate" fail 0 "$W/scripts/run" -c true -t -m

start_case; seed_datadir; export STUB_PSQL_TABLES=3
check "run -c true: database not empty after the wipe -> stops before migrate" fail 0 "$W/scripts/run" -c true -t -m
case "$LAST_OUT" in *"still has 3 table"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - no plain 'not empty' message"; esac

start_case; seed_datadir; export STUB_FAIL_PSQL=1
check "run -c true: emptiness cannot be checked -> stops before migrate" fail 0 "$W/scripts/run" -c true -t -m

start_case; seed_datadir
check "run -c true: empty database -> migrates once" ok 1 "$W/scripts/run" -c true -t -m

start_case; seed_datadir
check "run (plain start) on a populated database -> never migrates" ok 0 "$W/scripts/run" -t -m

start_case; seed_datadir; export STUB_FAIL_RM=1
check "run -b true (restore): data dir removal fails -> stops before migrate" fail 0 "$W/scripts/run" -b true -t -m

start_case; seed_datadir
check "run -b true (restore): wipe works -> migrates once" ok 1 "$W/scripts/run" -b true -t -m

# -----------------------------------------------------------------------------
# wipe-and-reboot.sh
# -----------------------------------------------------------------------------
echo "# scripts/wipe-and-reboot.sh (scripts from: $SRC)"

start_case; seed_volumes; export STUB_FAIL_VOLRM=1
check "wipe-and-reboot: volume removal fails -> stops before migrate" fail 0 "$W/scripts/wipe-and-reboot.sh" --yes --no-rebuild
case "$LAST_OUT" in *"booting stack"*) FAIL=$((FAIL + 1)); echo "FAIL - wipe-and-reboot went on to boot after the failed removal"; esac

start_case; seed_volumes
check "wipe-and-reboot: volumes removed -> migrates once" ok 1 "$W/scripts/wipe-and-reboot.sh" --yes --no-rebuild

echo
echo "passed: $PASS  failed: $FAIL"
exit "$FAIL"
