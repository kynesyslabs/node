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
#   - a probe or `up --wait` that hangs (Postgres up but silent) times out and
#     stops it before migrate, instead of hanging forever
#   - an empty database is migrated exactly once
#   - a plain start never migrates
#   - docker-run --clean runs `down` without --volumes and deletes only the
#     CLEAN_VOLUMES (PG data, node data), not the logs/prometheus/grafana ones
#   - run -c true falls back to `sudo rm` for a data dir the host user cannot
#     remove (files written by the Postgres container)
#   - run -c true wipes the data dir only after the container stopped (a failed
#     stop leaves the data in place), in the order stop, wipe, start, migrate
#   - run -c true / -b true migrate over the connection that was probed (the
#     launcher's container), whatever PG_* the shell or .env carry, and with
#     bun only (no node binary on the host)
#   - wipe-and-reboot.sh refuses before any wipe when scripts/docker-run is not
#     executable
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
REAL_SLEEP="$(command -v sleep)"
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
# STUB_HANG_PSQL=1: psql accepts the connection and never answers. Inside a
# `timeout N psql` it is killed (exit 124, at once: the stub does not wait N
# seconds); with no `timeout` around it, it really hangs, as the launcher would.
psql_hang() {
    [[ "${STUB_HANG_PSQL:-0}" == 1 ]] || return 0
    if [[ "$*" == *"timeout "[0-9]*" psql"* ]]; then
        echo "stub: psql hung, killed by timeout" >>"$STUB_ST/calls.log"
        exit 124
    fi
    "$STUB_REAL_SLEEP" 15   # longer than CHECK_TIMEOUT, short enough that an orphan ends soon
}
case "${1:-}" in
compose)
    sub=""
    for a in "$@"; do
        case "$a" in down|up|run|exec|version|build|logs) sub="$a"; break ;; esac
    done
    case "$sub" in
    down) [[ "${STUB_FAIL_DOWN:-0}" == 1 ]] && { echo "Error: cannot stop" >&2; exit 1; }; exit 0 ;;
    up)
        # STUB_HANG_UP=1: Postgres never becomes healthy. `up --wait` gives up
        # (non-zero) only when given --wait-timeout; otherwise it waits forever.
        if [[ "${STUB_HANG_UP:-0}" == 1 && " $* " == *" --wait "* ]]; then
            if [[ " $* " == *" --wait-timeout "* ]]; then echo "timed out waiting for postgres" >&2; exit 1; fi
            "$STUB_REAL_SLEEP" 15
        fi
        if [[ "$(basename "$PWD")" == postgres_* ]]; then
            mkdir -p "data_${PG_PORT:-5332}/postgres/tables"
        else
            mkdir -p "$STUB_ST/vol/demos_pgdata/tables"
        fi
        exit 0 ;;
    exec)
        psql_hang "$*"
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
    # the command run in the container: the first psql / pg_isready among the
    # arguments (skips `-e VAR=...` options and a `timeout N` wrapper)
    cmd=""
    for a in "$@"; do case "$a" in psql|pg_isready) cmd="$a"; break ;; esac; done
    case "$cmd" in
    pg_isready) exit 0 ;;
    psql)
        psql_hang "$*"
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
# migration:run, in either form. `bun run migration:run` goes through the
# package.json script (tsx), which needs a node binary: STUB_NO_NODE=1 is a host
# with Bun but no Node. The bun-direct form (typeorm's cli.js run by bun) does
# not. The connection the migration would use is logged with the MIGRATE line.
migrate() {
    echo "MIGRATE host=${PG_HOST-} port=${PG_PORT-} user=${PG_USER-} password=${PG_PASSWORD-} db=${PG_DATABASE-}" >>"$STUB_ST/migrate.log"
    d="$STUB_WORK/postgres_${PG_PORT:-5332}/data_${PG_PORT:-5332}/postgres/tables"
    mkdir -p "$d"
    touch "$d/migrations"
}
case "${1:-}" in
--version) echo 1.0.0 ;;
run)
    case "${2:-}" in
    migration:run)
        if [[ "${STUB_NO_NODE:-0}" == 1 ]]; then echo "tsx: node: command not found" >&2; exit 127; fi
        migrate ;;
    esac ;;
*)
    case " $* " in
    *" ./node_modules/typeorm/cli.js migration:run "*) migrate ;;
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

    # sudo fails, unless STUB_SUDO_OK=1 lets `sudo rm` act as root (who can
    # remove what the host user cannot)
    cat >"$bin/sudo" <<'EOF'
#!/usr/bin/env bash
[[ "${STUB_SUDO_OK:-0}" == 1 && "${1:-}" == rm ]] || exit 1
shift
exec "$STUB_REAL_RM" "$@"
EOF
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
        STUB_REAL_SLEEP="$REAL_SLEEP" GOSSIP_ENABLED=false timeout "${CHECK_TIMEOUT:-60}" "$@" 2>&1)"
    rc=$?
    mig="$(migrations)"
    [[ "$want_rc" == ok && "$rc" -ne 0 ]] && ok=0
    [[ "$want_rc" == fail && "$rc" -eq 0 ]] && ok=0
    # 124: the launcher itself hung until the harness killed it
    [[ "$rc" -eq 124 ]] && ok=0
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

start_case() { N=$((N + 1)); unset STUB_FAIL_DOWN STUB_FAIL_VOLRM STUB_FAIL_RM STUB_SUDO_OK STUB_FAIL_PSQL STUB_PSQL_TABLES STUB_HANG_PSQL STUB_HANG_UP STUB_NO_NODE PG_HOST PG_USER PG_PASSWORD PG_DATABASE CHECK_TIMEOUT; new_world; }

# the migration must have been given the launcher's own container as its database
expect_pinned_connection() {
    grep -qx 'MIGRATE host=localhost port=5332 user=demosuser password=demospassword db=demos' "$ST/migrate.log" 2>/dev/null \
        || { FAIL=$((FAIL + 1)); echo "FAIL - the migration did not connect to the probed container (got: $(cat "$ST/migrate.log" 2>/dev/null | tr '\n' ';'))"; }
}

# the hung stub must have been run under a bounded `timeout N psql`
expect_bounded_probe() {
    grep -qE 'timeout [0-9]+ psql' "$ST/calls.log" 2>/dev/null || { FAIL=$((FAIL + 1)); echo "FAIL - the psql probe has no timeout around it"; }
}

# -----------------------------------------------------------------------------
# docker-run
# -----------------------------------------------------------------------------
echo "# scripts/docker-run (scripts from: $SRC)"

start_case; seed_volumes; export STUB_FAIL_VOLRM=1
check "docker-run --clean: volume removal fails -> stops before migrate" fail 0 "$W/scripts/docker-run" --clean up -d
[[ -d "$ST/vol/demos_pgdata/tables" ]] || { FAIL=$((FAIL + 1)); echo "FAIL - volume demos_pgdata vanished"; }

start_case; seed_volumes; export STUB_FAIL_DOWN=1
check "docker-run --clean: stack teardown fails -> stops before migrate" fail 0 "$W/scripts/docker-run" --clean up -d
[[ -f "$ST/vol/demos_pgdata/tables/users" ]] || { FAIL=$((FAIL + 1)); echo "FAIL - volume demos_pgdata was wiped although the teardown failed"; }

# --clean must delete exactly the CLEAN_VOLUMES: `down` without --volumes (which
# would also drop the logs/prometheus/grafana volumes), the others left alone
start_case; seed_volumes; mkdir -p "$ST/vol/demos_node_logs" "$ST/vol/demos_prometheus_data" "$ST/vol/demos_grafana_data"
check "docker-run --clean: empty database -> migrates once (volume scope)" ok 1 "$W/scripts/docker-run" --clean up -d
grep -E 'docker compose .* down( |$)' "$ST/calls.log" | grep -qE -e '--volumes|down -v| -v( |$)' \
    && { FAIL=$((FAIL + 1)); echo "FAIL - docker-run --clean passed --volumes to compose down"; }
grep -qE 'docker compose .* down .*--remove-orphans' "$ST/calls.log" || { FAIL=$((FAIL + 1)); echo "FAIL - docker-run --clean did not run compose down --remove-orphans"; }
for vol in demos_pgdata demos_node_data; do
    # (the stub's `up` recreates an empty demos_pgdata, so look for the removal call)
    grep -qE "^docker volume rm $vol\$" "$ST/calls.log" || { FAIL=$((FAIL + 1)); echo "FAIL - docker-run --clean did not remove volume $vol"; }
done
for vol in demos_node_state demos_node_logs demos_prometheus_data demos_grafana_data; do
    [[ -d "$ST/vol/$vol" ]] || { FAIL=$((FAIL + 1)); echo "FAIL - docker-run --clean deleted volume $vol, which is not in CLEAN_VOLUMES"; }
done

start_case; seed_volumes; export STUB_PSQL_TABLES=2
check "docker-run --clean: database not empty after the wipe -> stops before migrate" fail 0 "$W/scripts/docker-run" --clean up -d
case "$LAST_OUT" in *"still has 2 table"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - no plain 'not empty' message"; esac

start_case; seed_volumes; export STUB_FAIL_PSQL=1
check "docker-run --clean: emptiness cannot be checked -> stops before migrate" fail 0 "$W/scripts/docker-run" --clean up -d

start_case; seed_volumes; export STUB_HANG_PSQL=1 CHECK_TIMEOUT=8
check "docker-run --clean: emptiness probe hangs -> times out, stops before migrate" fail 0 "$W/scripts/docker-run" --clean up -d
case "$LAST_OUT" in *"could not check that the database is empty"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - no plain 'could not check' message"; esac
expect_bounded_probe

start_case; seed_volumes; export STUB_HANG_UP=1 CHECK_TIMEOUT=8
check "docker-run --clean: postgres never becomes ready (up --wait) -> times out, stops before migrate" fail 0 "$W/scripts/docker-run" --clean up -d

start_case; seed_volumes
check "docker-run --clean: empty database -> migrates once" ok 1 "$W/scripts/docker-run" --clean up -d

start_case; seed_volumes
check "docker-run up -d (no --clean) on a populated database -> never migrates" ok 0 "$W/scripts/docker-run" up -d

# --clean migrates on the existing local image, so --build / --pull (which only
# reach the final `up`) must be refused before anything is wiped
for flag in --build --pull --pull=always; do
    start_case; seed_volumes
    check "docker-run --clean $flag: refused before the wipe, nothing migrated" fail 0 "$W/scripts/docker-run" --clean "$flag" up -d
    case "$LAST_OUT" in *"--rebuild"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - docker-run --clean $flag: the refusal does not point to --rebuild"; esac
    [[ -f "$ST/vol/demos_pgdata/tables/users" ]] || { FAIL=$((FAIL + 1)); echo "FAIL - docker-run --clean $flag: volume demos_pgdata was wiped before the refusal"; }
done
start_case; seed_volumes
check "docker-run --clean --build (flag after up): refused before the wipe" fail 0 "$W/scripts/docker-run" --clean up --build -d
start_case; seed_volumes
check "docker-run --clean --rebuild: still allowed, migrates once" ok 1 "$W/scripts/docker-run" --clean --rebuild up -d

# -----------------------------------------------------------------------------
# scripts/run
# -----------------------------------------------------------------------------
echo "# scripts/run (scripts from: $SRC)"

start_case; seed_datadir; export STUB_FAIL_RM=1
check "run -c true: data dir removal fails -> stops before migrate" fail 0 "$W/scripts/run" -c true -t -m

start_case; seed_datadir; export STUB_FAIL_RM=1 STUB_SUDO_OK=1
check "run -c true: data dir only root can remove -> sudo rm wipes it, migrates once" ok 1 "$W/scripts/run" -c true -t -m
[[ -f "$W/postgres_5332/data_5332/postgres/tables/users" ]] && { FAIL=$((FAIL + 1)); echo "FAIL - run -c true left the old data after the sudo fallback"; }

start_case; seed_datadir; export STUB_FAIL_DOWN=1
check "run -c true: container stop fails -> stops before migrate" fail 0 "$W/scripts/run" -c true -t -m
# a failed stop must leave the data dir untouched: "the database was not wiped" is then true
[[ -f "$W/postgres_5332/data_5332/postgres/tables/users" ]] || { FAIL=$((FAIL + 1)); echo "FAIL - run -c true removed the data dir before the container stop failed"; }
case "$LAST_OUT" in *"the database was not wiped"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - no 'database was not wiped' message"; esac

start_case; seed_datadir; export STUB_PSQL_TABLES=3
check "run -c true: database not empty after the wipe -> stops before migrate" fail 0 "$W/scripts/run" -c true -t -m
case "$LAST_OUT" in *"still has 3 table"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - no plain 'not empty' message"; esac

start_case; seed_datadir; export STUB_FAIL_PSQL=1
check "run -c true: emptiness cannot be checked -> stops before migrate" fail 0 "$W/scripts/run" -c true -t -m

start_case; seed_datadir; export STUB_HANG_PSQL=1 CHECK_TIMEOUT=8
check "run -c true: emptiness probe hangs -> times out, stops before migrate" fail 0 "$W/scripts/run" -c true -t -m
case "$LAST_OUT" in *"Could not check that the database is empty"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - no plain 'could not check' message"; esac
expect_bounded_probe

start_case; seed_datadir
check "run -c true: empty database -> migrates once" ok 1 "$W/scripts/run" -c true -t -m
# order: stop, then wipe, then start, then migrate; the old rows are gone
[[ -f "$W/postgres_5332/data_5332/postgres/tables/users" ]] && { FAIL=$((FAIL + 1)); echo "FAIL - run -c true left the old data in the data dir"; }
[[ -f "$W/postgres_5332/data_5332/postgres/tables/migrations" ]] || { FAIL=$((FAIL + 1)); echo "FAIL - run -c true did not migrate the wiped data dir"; }
grep -nE 'docker compose .* (down|up)( |$)|bun .*migration:run' "$ST/calls.log" | sed -E 's/^[0-9]+:docker compose .* (down|up)( .*|$)/\1/; s/^[0-9]+:bun .*migration:run.*/migrate/' | tr '\n' ' ' \
    | grep -qE '^down up migrate ' || { FAIL=$((FAIL + 1)); echo "FAIL - run -c true: wrong order of stop / start / migrate (got: $(grep -oE 'compose .* (down|up)|migration:run' "$ST/calls.log" | tr '\n' ';'))"; }

start_case; seed_datadir
check "run (plain start) on a populated database -> never migrates" ok 0 "$W/scripts/run" -t -m

start_case; seed_datadir; export STUB_FAIL_RM=1
check "run -b true (restore): data dir removal fails -> stops before migrate" fail 0 "$W/scripts/run" -b true -t -m

start_case; seed_datadir
check "run -b true (restore): wipe works -> migrates once" ok 1 "$W/scripts/run" -b true -t -m
[[ -f "$W/postgres_5332/data_5332/postgres/tables/users" ]] && { FAIL=$((FAIL + 1)); echo "FAIL - run -b true left the old data in the data dir"; }

# The migration must hit the database that was probed, whatever PG_* the shell
# or .env carry (dotenv never overrides a variable that is already set)
start_case; seed_datadir; export PG_HOST=db.example.org PG_USER=other PG_PASSWORD=secret PG_DATABASE=otherdb
check "run -c true: PG_* pointing elsewhere -> migration still uses the probed container" ok 1 "$W/scripts/run" -c true -t -m
expect_pinned_connection

start_case; seed_datadir; export PG_HOST=db.example.org PG_USER=other PG_PASSWORD=secret PG_DATABASE=otherdb
check "run -b true (restore): PG_* pointing elsewhere -> migration still uses the probed container" ok 1 "$W/scripts/run" -b true -t -m
expect_pinned_connection

# A host with Bun but no Node (GOSSIP_ENABLED=false) passes the launcher's
# checks: the schema must still be created after the wipe
start_case; seed_datadir; export STUB_NO_NODE=1
check "run -c true: no node binary -> migrates once (bun runs typeorm directly)" ok 1 "$W/scripts/run" -c true -t -m

start_case; seed_datadir; export STUB_NO_NODE=1
check "run -b true (restore): no node binary -> migrates once" ok 1 "$W/scripts/run" -b true -t -m

# -----------------------------------------------------------------------------
# wipe-and-reboot.sh
# -----------------------------------------------------------------------------
echo "# scripts/wipe-and-reboot.sh (scripts from: $SRC)"

start_case; seed_volumes; export STUB_FAIL_VOLRM=1
check "wipe-and-reboot: volume removal fails -> stops before migrate" fail 0 "$W/scripts/wipe-and-reboot.sh" --yes --no-rebuild
case "$LAST_OUT" in *"booting stack"*) FAIL=$((FAIL + 1)); echo "FAIL - wipe-and-reboot went on to boot after the failed removal"; esac

start_case; seed_volumes
check "wipe-and-reboot: volumes removed -> migrates once" ok 1 "$W/scripts/wipe-and-reboot.sh" --yes --no-rebuild

# Without an executable scripts/docker-run nothing creates the schema, so the
# script must refuse before it deletes anything, and never boot with raw compose
start_case; seed_volumes; chmod -x "$W/scripts/docker-run"
check "wipe-and-reboot: scripts/docker-run not executable -> refuses before the wipe" fail 0 "$W/scripts/wipe-and-reboot.sh" --yes --no-rebuild
[[ -d "$ST/vol/demos_pgdata" && -f "$ST/vol/demos_pgdata/tables/users" ]] || { FAIL=$((FAIL + 1)); echo "FAIL - wipe-and-reboot removed the PG volume although scripts/docker-run is not executable"; }
grep -qE 'docker compose .*up' "$ST/calls.log" 2>/dev/null && { FAIL=$((FAIL + 1)); echo "FAIL - wipe-and-reboot ran a raw 'docker compose up' without scripts/docker-run"; }

echo
echo "passed: $PASS  failed: $FAIL"
exit "$FAIL"
