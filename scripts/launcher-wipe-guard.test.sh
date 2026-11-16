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
#   - wipe-and-reboot.sh keeps the node state volume (signing record, commit
#     lock) unless --wipe-signing-state is given, and warns when it is
#   - reset-node keeps every signing-state file next to the identity (signing
#     record, halt marker, commit lock, prevote record), and when the clone
#     fails and a backup cannot be moved back it says where the backup is; a
#     restore that fails or finds no backup after a clean clone stops the reset
#   - docker-run `down -v` / `down --volumes` (also in a flag group such as
#     -vt 0) lists the stack's declared named volumes, says anonymous volumes
#     go too, and runs compose only after `delete` is typed on a terminal
#     (script(1) pty) or with --yes-delete-volumes; plain
#     `down`, `down -t 0` and `down --volumes=false` are unchanged, and the
#     last volume setting decides (`-v --volumes=false` does not ask)
#   - reset-node stops before it deletes anything while a container of this
#     checkout runs (also one labelled with a link to it), a bun process works
#     in it (with /proc; not one that started reset-node, nor one in a sibling
#     directory) or the identity lock counts (on this host: a fresh heartbeat,
#     or for a lock without one a live pid; a lock from another host whatever
#     its age), also when the lock sits next to the target of a linked
#     identity and readlink -f is missing, and for the lock of the
#     IDENTITY_FILE of its environment or of the checkout's .env (quoted, with
#     a comment; no other line of .env is printed; one that does not exist has
#     no lock);
#     it stops when that link cannot be followed, the lock's directory cannot
#     be searched or the lock cannot be read in full (mode 000, a failed read,
#     empty, no pid or hostname, cut off before its closing brace) or no
#     temporary file can be made for the container list, and goes on
#     (checking the processes and locks only) when docker is missing,
#     unreachable or gives no answer within 10s; it checks again after the
#     prompt (a lock taken or an identity file made while it waits) and
#     before the removal (a container started after the backup, whose backups
#     it then names and keeps)
#   - reset-node stops before the prompt when the IDENTITY_FILE of its
#     environment, other than .demos_identity, or one of its signing files is
#     in the checkout, and goes on when they are outside it
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
# package.json script: STUB_NO_NODE=1 fails it the way a host with Bun but no
# Node did while that script ran through tsx, so the launchers must spell out
# the bun-direct form (typeorm's cli.js run by bun), whatever package.json
# says. The connection the migration would use is logged with the MIGRATE line.
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

# down -v / --volumes deletes the stack's declared named volumes and the
# anonymous ones attached to its containers: the named ones are listed, and
# compose runs only after `delete` is typed on a terminal or with
# --yes-delete-volumes. Plain `down` is unchanged.
compose_down_called() { grep -qE '^docker compose .* down( |$)' "$ST/calls.log" 2>/dev/null; }

start_case; seed_volumes
check "docker-run down -v, no terminal, no flag: refused, compose not called" fail 0 "$W/scripts/docker-run" down -v </dev/null
compose_down_called && { FAIL=$((FAIL + 1)); echo "FAIL - docker-run down -v without a terminal ran compose down"; }
for vol in demos_pgdata demos_node_data demos_node_state demos_grafana_data demos_caddy_config; do
    case "$LAST_OUT" in *"    $vol"$'\n'*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - docker-run down -v did not list $vol";; esac
done
case "$LAST_OUT" in *--yes-delete-volumes*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - docker-run down -v refusal does not name --yes-delete-volumes";; esac
case "$LAST_OUT" in *"declared named volumes"*"anonymous volumes attached to its containers"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - docker-run down -v does not say the list is the named volumes and anonymous ones go too";; esac

start_case
check "docker-run --port 53650 down --volumes, no terminal: refused, lists the _53650 volumes" fail 0 "$W/scripts/docker-run" --port 53650 down --volumes </dev/null
compose_down_called && { FAIL=$((FAIL + 1)); echo "FAIL - docker-run --port 53650 down --volumes without a terminal ran compose down"; }
case "$LAST_OUT" in *demos_pgdata_53650*demos_node_state_53650*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - docker-run --port 53650 down --volumes did not list the _53650 volumes";; esac

start_case; : >"$W/docker-compose.devnet.yml"
check "docker-run --devnet down -v, no terminal: refused, lists the _devnet volumes" fail 0 "$W/scripts/docker-run" --devnet down -v </dev/null
compose_down_called && { FAIL=$((FAIL + 1)); echo "FAIL - docker-run --devnet down -v without a terminal ran compose down"; }
case "$LAST_OUT" in *demos_pgdata_devnet*demos_node_state_devnet*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - docker-run --devnet down -v did not list the _devnet volumes";; esac

start_case
check "docker-run --yes-delete-volumes down -v, no terminal: compose down -v runs" ok 0 "$W/scripts/docker-run" --yes-delete-volumes down -v </dev/null
grep -qE '^docker compose .* down -v$' "$ST/calls.log" || { FAIL=$((FAIL + 1)); echo "FAIL - docker-run --yes-delete-volumes down -v did not run compose down -v"; }

start_case
check "docker-run down (no -v): compose down runs, no prompt" ok 0 "$W/scripts/docker-run" down </dev/null
grep -qE '^docker compose .* down$' "$ST/calls.log" || { FAIL=$((FAIL + 1)); echo "FAIL - docker-run down did not run compose down"; }
case "$LAST_OUT" in *"cannot be recovered"*) FAIL=$((FAIL + 1)); echo "FAIL - docker-run down (no -v) asked about volumes";; esac

# Compose reads a short flag group that starts with v as -v (-vt 0 is -v -t 0);
# -tv is refused by compose, and the guard asks anyway. The last volume
# setting wins. The spelling is split into its words on purpose
for spelling in "-vt 0" "-vt0" "-tv" "--volumes=true" "--volumes=false -v"; do
    start_case
    check "docker-run down $spelling, no terminal: refused, compose not called" fail 0 "$W/scripts/docker-run" down $spelling </dev/null
    compose_down_called && { FAIL=$((FAIL + 1)); echo "FAIL - docker-run down $spelling without a terminal ran compose down"; }
done
# --volumes=<false> (compose parses it with strconv.ParseBool), also after -v,
# and -t 0 delete nothing
for spelling in "--volumes=false" "--volumes=0" "-v --volumes=false" "-t 0"; do
    start_case
    check "docker-run down $spelling: compose down runs, no prompt" ok 0 "$W/scripts/docker-run" down $spelling </dev/null
    grep -qE "^docker compose .* down $spelling\$" "$ST/calls.log" || { FAIL=$((FAIL + 1)); echo "FAIL - docker-run down $spelling did not run compose down $spelling"; }
    case "$LAST_OUT" in *"cannot be recovered"*) FAIL=$((FAIL + 1)); echo "FAIL - docker-run down $spelling asked about volumes";; esac
done

# On a terminal: a pty from util-linux script(1), the answer typed on its stdin
if script -qec true /dev/null </dev/null >/dev/null 2>&1; then
    start_case
    check "docker-run down -v on a terminal, 'delete' typed: compose down -v runs" ok 0 \
        script -qec "$(printf '%q ' "$W/scripts/docker-run" down -v)" /dev/null <<<"delete"
    grep -qE '^docker compose .* down -v$' "$ST/calls.log" || { FAIL=$((FAIL + 1)); echo "FAIL - docker-run down -v did not run compose down -v after 'delete'"; }
    case "$LAST_OUT" in *"Type delete"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - docker-run down -v on a terminal showed no prompt";; esac

    for answer in yes Delete ""; do
        start_case
        check "docker-run down -v on a terminal, '$answer' typed: not confirmed, compose not called" fail 0 \
            script -qec "$(printf '%q ' "$W/scripts/docker-run" down -v)" /dev/null <<<"$answer"
        compose_down_called && { FAIL=$((FAIL + 1)); echo "FAIL - docker-run down -v ran compose down after '$answer'"; }
    done
else
    echo "skip - docker-run down -v terminal cases: util-linux script(1) not available"
fi

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
# The state volume carries the signing record and commit lock: a plain wipe
# keeps it, only --wipe-signing-state deletes it, and says so loudly
[[ -d "$ST/vol/demos_node_state" ]] || { FAIL=$((FAIL + 1)); echo "FAIL - wipe-and-reboot deleted demos_node_state (the signing record) without --wipe-signing-state"; }
[[ -d "$ST/vol/demos_node_data" ]] && { FAIL=$((FAIL + 1)); echo "FAIL - wipe-and-reboot kept demos_node_data"; }

start_case; seed_volumes
check "wipe-and-reboot --wipe-signing-state: state volume removed -> migrates once" ok 1 "$W/scripts/wipe-and-reboot.sh" --yes --no-rebuild --wipe-signing-state
[[ -d "$ST/vol/demos_node_state" ]] && { FAIL=$((FAIL + 1)); echo "FAIL - wipe-and-reboot --wipe-signing-state kept demos_node_state"; }
case "$LAST_OUT" in *"signing record"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - wipe-and-reboot --wipe-signing-state did not warn about the signing record";; esac

# Without an executable scripts/docker-run nothing creates the schema, so the
# script must refuse before it deletes anything, and never boot with raw compose
start_case; seed_volumes; chmod -x "$W/scripts/docker-run"
check "wipe-and-reboot: scripts/docker-run not executable -> refuses before the wipe" fail 0 "$W/scripts/wipe-and-reboot.sh" --yes --no-rebuild
[[ -d "$ST/vol/demos_pgdata" && -f "$ST/vol/demos_pgdata/tables/users" ]] || { FAIL=$((FAIL + 1)); echo "FAIL - wipe-and-reboot removed the PG volume although scripts/docker-run is not executable"; }
grep -qE 'docker compose .*up' "$ST/calls.log" 2>/dev/null && { FAIL=$((FAIL + 1)); echo "FAIL - wipe-and-reboot ran a raw 'docker compose up' without scripts/docker-run"; }

# -----------------------------------------------------------------------------
# reset-node
# -----------------------------------------------------------------------------
echo "# scripts/reset-node (scripts from: $SRC)"

RESET_SIGNING=(.demos_identity.signed.json .demos_identity.signed.json.halted .demos_identity.commitlock.json .demos_identity.prevote.json)
# What reset-node says whenever it stops before it deletes anything
NOTHING_DELETED="Nothing was deleted"
# Only the cases below that set it give reset-node an IDENTITY_FILE
unset IDENTITY_FILE

# A node checkout with an identity and every signing-state file. git clone
# makes an empty checkout (or fails with STUB_FAIL_CLONE=1, or first deletes
# the backup of STUB_DROP_BACKUP) and mv fails on a .backup file with
# STUB_FAIL_MV=1.
new_reset_world() {
    N=$((N + 1))
    W="$ROOT/r$N"
    mkdir -p "$W/node" "$W/bin"
    cp "$SRC/reset-node" "$W/reset-node" || { echo "missing $SRC/reset-node" >&2; exit 99; }
    chmod +x "$W/reset-node"
    echo '{"name":"demos-node"}' >"$W/node/package.json"
    local f
    for f in .demos_identity "${RESET_SIGNING[@]}"; do echo "$f" >"$W/node/$f"; done
    cat >"$W/bin/git" <<'STUB'
#!/usr/bin/env bash
[[ "${1:-}" == clone ]] || exit 0
[[ "${STUB_FAIL_CLONE:-0}" == 1 ]] && { echo "fatal: unable to access" >&2; exit 128; }
[[ -n "${STUB_DROP_BACKUP:-}" ]] && rm -f "$PWD/$STUB_DROP_BACKUP.backup"
mkdir -p "${3:?}"
STUB
    cat >"$W/bin/mv" <<'STUB'
#!/usr/bin/env bash
if [[ "${STUB_FAIL_MV:-0}" == 1 && "${1:-}" == *.backup ]]; then
    echo "mv: cannot move '$1': Permission denied" >&2
    exit 1
fi
exec "$STUB_REAL_MV" "$@"
STUB
    printf '#!/usr/bin/env bash\nexit 0\n' >"$W/bin/bun"
    # docker ps prints STUB_PS ("<name> <compose working dir>" lines), from
    # its STUB_PS_FROM-th call on (default: every call);
    # STUB_DOCKER_DOWN=1: the daemon cannot be reached; STUB_DOCKER_HANG=1: it
    # never answers (sleeps 30s, then lists nothing), the stub's pid in docker.pid
    cat >"$W/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >>"$STUB_RESET_DIR/docker.log"
[[ "${STUB_DOCKER_DOWN:-0}" == 1 ]] && { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
[[ "${STUB_DOCKER_HANG:-0}" == 1 ]] && { echo $$ >"$STUB_RESET_DIR/docker.pid"; exec sleep 30; }
[[ "${1:-}" == ps && "$(grep -c '^docker ps' "$STUB_RESET_DIR/docker.log")" -ge "${STUB_PS_FROM:-1}" ]] && printf '%b' "${STUB_PS:-}"
exit 0
STUB
    chmod +x "$W/bin/git" "$W/bin/mv" "$W/bin/bun" "$W/bin/docker"
}

# reset_check NAME EXPECT_RC ARGS...   (EXPECT_RC: ok | fail)
reset_check() {
    local name="$1" want_rc="$2"
    shift 2
    local out rc
    out="$(cd "$W/node" && env PATH="$W/bin:$PATH" STUB_REAL_MV="$(command -v mv)" STUB_RESET_DIR="$W" \
        timeout 60 "$W/reset-node" "$@" 2>&1)"
    rc=$?
    reset_result "$name" "$want_rc" "$rc" "$out"
}

# reset_result NAME EXPECT_RC RC OUTPUT
reset_result() {
    local name="$1" want_rc="$2" rc="$3" out="$4"
    if [[ ("$want_rc" == ok && "$rc" -eq 0) || ("$want_rc" == fail && "$rc" -ne 0 && "$rc" -ne 124) ]]; then
        PASS=$((PASS + 1))
        echo "ok   - $name (exit $rc)"
    else
        FAIL=$((FAIL + 1))
        echo "FAIL - $name: exit $rc (want $want_rc)"
        echo "$out" | tail -8 | sed 's/^/         | /'
    fi
    LAST_OUT="$out"
}

# reset_prompt_check NAME EXPECT_RC ACTION...: reset-node without -y; ACTION
# runs while the prompt waits for its answer (up to 30s), then y is typed
reset_prompt_check() {
    local name="$1" want_rc="$2" i rc
    shift 2
    {
        for ((i = 0; i < 300; i++)); do
            grep -qF "WARNING: This will delete" "$W/out" 2>/dev/null && break
            sleep 0.1
        done
        "$@"
        echo y
    } | (cd "$W/node" && env PATH="$W/bin:$PATH" STUB_REAL_MV="$(command -v mv)" STUB_RESET_DIR="$W" \
        timeout 60 "$W/reset-node" >"$W/out" 2>&1)
    rc=${PIPESTATUS[1]}
    reset_result "$name" "$want_rc" "$rc" "$(cat "$W/out")"
}

new_reset_world
reset_check "reset-node: nothing running -> plain reset completes" ok -y
for f in .demos_identity "${RESET_SIGNING[@]}"; do
    [[ -f "$W/node/$f" ]] || { FAIL=$((FAIL + 1)); echo "FAIL - reset-node dropped $f"; }
done
grep -q '^docker ps .*com.docker.compose.project.working_dir' "$W/docker.log" 2>/dev/null || { FAIL=$((FAIL + 1)); echo "FAIL - reset-node did not ask docker for the containers of this checkout"; }

# Nothing of the checkout was touched: no backup made, the directory not replaced
expect_untouched() {
    [[ -f "$W/node/package.json" && -f "$W/node/.demos_identity" && -f "$W/node/.demos_identity.commitlock.json" ]] \
        || { FAIL=$((FAIL + 1)); echo "FAIL - $1: the node directory was changed"; }
    if compgen -G "$W/*.backup" >/dev/null; then FAIL=$((FAIL + 1)); echo "FAIL - $1: backups were made"; fi
}
# write_lock PID HOSTNAME HEARTBEAT_MS [FILE]: the identity lock as the node writes it
write_lock() {
    printf '{"pid":%s,"hostname":"%s","instance":"0f0e","seq":3,"heartbeat":%s}' "$1" "$2" "$3" >"${4:-$W/node/.demos_identity.lock}"
}
# write_old_lock PID HOSTNAME: a lock from a node before the heartbeat (no heartbeat field)
write_old_lock() {
    printf '{"pid":%s,"hostname":"%s"}' "$1" "$2" >"$W/node/.demos_identity.lock"
}
( : ) &
DEAD_PID=$!
wait "$DEAD_PID"
# The host name the node writes (os.hostname()) and reset-node compares with
THIS_HOST="$(uname -n)"
# readlink that fails on -f, as on macOS before 12.3; logs its calls
stub_readlink_no_f() {
    printf '#!/usr/bin/env bash\necho "readlink $*" >>"$STUB_RESET_DIR/readlink.log"\n[[ "${1:-}" == -f ]] && { echo "readlink: illegal option -- f" >&2; exit 1; }\nexec %q "$@"\n' "$(command -v readlink)" >"$W/bin/readlink"
    chmod +x "$W/bin/readlink"
}

# A container started from this checkout: docker-run's stack, or ./run's
# Postgres, whose compose project sits in postgres_<port> under the checkout
new_reset_world
export STUB_PS="demos-node $W/node\ndemos-postgres $W/node\n"
reset_check "reset-node: a docker-run container of this checkout runs -> refuses, deletes nothing" fail -y
unset STUB_PS
expect_untouched "reset-node with demos-node running"
case "$LAST_OUT" in *"Container demos-node of this checkout"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - reset-node did not name the running container";; esac

new_reset_world
export STUB_PS="postgres_5332 $W/node/postgres_5332\n"
reset_check "reset-node: ./run's postgres_5332 container runs -> refuses, deletes nothing" fail -y
unset STUB_PS
expect_untouched "reset-node with postgres_5332 running"

new_reset_world
export STUB_PS="demos-node $ROOT/other/node\ndemos-node_53650 $W/node-old\n"
reset_check "reset-node: only another checkout's containers run -> proceeds" ok -y
unset STUB_PS

# Compose labels the path it ran from: a stack started through a link to this
# checkout counts, one through a link to another checkout (or with no compose
# label at all) does not
new_reset_world
ln -s node "$W/node-link"
export STUB_PS="demos-node $W/node-link\n"
reset_check "reset-node: a container labelled with a link to this checkout runs -> refuses, deletes nothing" fail -y
unset STUB_PS
expect_untouched "reset-node with a container started through a link"
case "$LAST_OUT" in *"Container demos-node of this checkout"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - reset-node did not name the container started through a link";; esac

new_reset_world
mkdir -p "$W/node-old"
ln -s node-old "$W/old-link"
export STUB_PS="plain-container \ndemos-node_53650 $W/old-link\n"
reset_check "reset-node: containers labelled with a link to another checkout or with no label run -> proceeds" ok -y
unset STUB_PS

# A local node: the identity lock it refreshes every 5s. As in the node, the
# pid counts only for a lock without a heartbeat, and only on this host
new_reset_world
write_lock "$DEAD_PID" "$THIS_HOST" "$(($(date +%s) * 1000))"
reset_check "reset-node: identity lock with a fresh heartbeat -> refuses, deletes nothing" fail -y
expect_untouched "reset-node with a fresh identity lock"
case "$LAST_OUT" in *"Identity lock $W/node/.demos_identity.lock is held"*"heartbeat "[0-9]*"s ago"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - reset-node did not name the identity lock and its heartbeat age";; esac
case "$LAST_OUT" in *"If no node is running"*"can be removed: $W/node/.demos_identity.lock"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - reset-node did not say the lock can be removed if no node is running";; esac

# a crash or reboot, then the pid reused by an unrelated process
new_reset_world
write_lock "$$" "$THIS_HOST" 1000
reset_check "reset-node: old heartbeat, live unrelated pid on this host -> proceeds" ok -y

new_reset_world
write_old_lock "$$" "$THIS_HOST"
reset_check "reset-node: lock without a heartbeat, live pid on this host -> refuses, deletes nothing" fail -y
expect_untouched "reset-node with a live holder of a lock without a heartbeat"
case "$LAST_OUT" in *"Identity lock $W/node/.demos_identity.lock is held by pid $$"*"no heartbeat"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - reset-node did not name the lock without a heartbeat and its pid";; esac

new_reset_world
write_old_lock "$DEAD_PID" "$THIS_HOST"
reset_check "reset-node: lock without a heartbeat, dead pid -> proceeds" ok -y

# A lock from another host counts whatever its age: clocks of two hosts can
# differ, so the node watches such a lock instead of trusting its age
new_reset_world
write_lock "$DEAD_PID" other-host "$(($(date +%s) * 1000 - 3600000))"
reset_check "reset-node: lock from another host, heartbeat 1h old -> refuses, deletes nothing" fail -y
expect_untouched "reset-node with an old lock from another host"
case "$LAST_OUT" in *"Identity lock $W/node/.demos_identity.lock was written on another host, other-host"*"heartbeat 360"[0-9]"s ago"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - reset-node did not name the other host's lock, its host and its heartbeat age";; esac
case "$LAST_OUT" in *"If no node on other-host uses this checkout, remove the lock file and run reset-node again: $W/node/.demos_identity.lock"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - reset-node did not say when the other host's lock can be removed";; esac

new_reset_world
write_lock "$DEAD_PID" other-host "$(($(date +%s) * 1000))"
reset_check "reset-node: lock from another host, fresh heartbeat -> refuses, deletes nothing" fail -y
expect_untouched "reset-node with a fresh lock from another host"

new_reset_world
write_old_lock "$DEAD_PID" other-host
reset_check "reset-node: lock without a heartbeat from another host -> refuses, deletes nothing" fail -y
expect_untouched "reset-node with a lock without a heartbeat from another host"

# The lock sits next to the real identity file when .demos_identity is a link
new_reset_world
mkdir -p "$W/state"
mv "$W/node/.demos_identity" "$W/state/.demos_identity"
ln -s "$W/state/.demos_identity" "$W/node/.demos_identity"
write_lock "$$" "$THIS_HOST" "$(($(date +%s) * 1000))" "$W/state/.demos_identity.lock"
reset_check "reset-node: lock next to a linked identity -> refuses" fail -y
[[ -f "$W/node/package.json" ]] || { FAIL=$((FAIL + 1)); echo "FAIL - reset-node with a linked identity lock: the node directory was changed"; }

# Without readlink -f the links are followed one by one, each relative target
# from the link's directory: node/.demos_identity -> ../state/link -> real/...
linked_identity_world() {
    new_reset_world
    stub_readlink_no_f
    mkdir -p "$W/state/real"
    mv "$W/node/.demos_identity" "$W/state/real/.demos_identity"
    ln -s ../state/link "$W/node/.demos_identity"
    ln -s real/.demos_identity "$W/state/link"
}
linked_identity_world
write_lock "$DEAD_PID" "$THIS_HOST" "$(($(date +%s) * 1000))" "$W/state/real/.demos_identity.lock"
reset_check "reset-node: readlink -f fails, fresh lock next to the end of a relative link chain -> refuses, deletes nothing" fail -y
expect_untouched "reset-node without readlink -f and a linked identity lock"
case "$LAST_OUT" in *"Identity lock "*"/state/real/.demos_identity.lock is held"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - reset-node without readlink -f did not find the lock next to the link chain's end";; esac
grep -q '^readlink -f' "$W/readlink.log" 2>/dev/null && grep -q '^readlink [^-]' "$W/readlink.log" \
    || { FAIL=$((FAIL + 1)); echo "FAIL - reset-node did not fall back from readlink -f to plain readlink"; }

linked_identity_world
reset_check "reset-node: readlink -f fails, relative link chain, no lock -> proceeds" ok -y

# The lock next to the IDENTITY_FILE of reset-node's environment or of the
# checkout's .env counts too; .env is read for that key only
validator_key_world() {
    new_reset_world
    echo validator.key >"$W/node/validator.key"
    write_lock "$DEAD_PID" "$THIS_HOST" "$(($(date +%s) * 1000))" "$W/node/validator.key.lock"
}
validator_key_world
IDENTITY_FILE=validator.key reset_check "reset-node: IDENTITY_FILE in the environment, fresh lock next to it -> refuses, deletes nothing" fail -y
expect_untouched "reset-node with IDENTITY_FILE in the environment"
case "$LAST_OUT" in *"Identity lock $W/node/validator.key.lock is held"*"$NOTHING_DELETED"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - reset-node did not name the lock of the IDENTITY_FILE of its environment";; esac

validator_key_world
printf 'ENV_CANARY=do-not-print\nIDENTITY_FILE="validator.key" # the validator key\n' >"$W/node/.env"
reset_check "reset-node: .env sets IDENTITY_FILE (quoted, with a comment), fresh lock next to it -> refuses, deletes nothing" fail -y
expect_untouched "reset-node with IDENTITY_FILE in .env"
case "$LAST_OUT" in *"Identity lock $W/node/validator.key.lock is held"*"$NOTHING_DELETED"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - reset-node did not name the lock of the IDENTITY_FILE of .env";; esac
case "$LAST_OUT" in *do-not-print*) FAIL=$((FAIL + 1)); echo "FAIL - reset-node printed another line of .env";; esac

validator_key_world
printf 'ENV_CANARY=do-not-print\n# IDENTITY_FILE=validator.key\n' >"$W/node/.env"
reset_check "reset-node: .env without IDENTITY_FILE, lock next to an unconfigured file -> proceeds" ok -y

new_reset_world
write_lock "$DEAD_PID" "$THIS_HOST" "$(($(date +%s) * 1000))" "$W/node/missing.key.lock"
IDENTITY_FILE=missing.key reset_check "reset-node: IDENTITY_FILE names a file that does not exist -> proceeds" ok -y

# The reset keeps only .demos_identity and its files: another configured
# identity, or a signing file of it, in the checkout stops it before the prompt
KEEPS_ONLY="The reset keeps only .demos_identity and its files"
new_reset_world
echo validator.key >"$W/node/validator.key"
IDENTITY_FILE=validator.key reset_check "reset-node: IDENTITY_FILE in the checkout, no lock -> refuses before the prompt, deletes nothing" fail </dev/null
expect_untouched "reset-node with IDENTITY_FILE in the checkout"
[[ -f "$W/node/validator.key" ]] || { FAIL=$((FAIL + 1)); echo "FAIL - reset-node removed the IDENTITY_FILE in the checkout"; }
case "$LAST_OUT" in *"$W/node/validator.key (of IDENTITY_FILE=validator.key) is in this checkout"*"$KEEPS_ONLY"*"$NOTHING_DELETED"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - reset-node did not name the IDENTITY_FILE in the checkout";; esac
case "$LAST_OUT" in *"WARNING: This will delete"*) FAIL=$((FAIL + 1)); echo "FAIL - reset-node prompted with the IDENTITY_FILE in the checkout";; esac

new_reset_world
echo record >"$W/node/validator.key.signed.json"
IDENTITY_FILE=validator.key reset_check "reset-node: only the signing record of IDENTITY_FILE in the checkout -> refuses, deletes nothing" fail -y
expect_untouched "reset-node with the signing record of IDENTITY_FILE in the checkout"
case "$LAST_OUT" in *"$W/node/validator.key.signed.json (of IDENTITY_FILE=validator.key) is in this checkout"*"$KEEPS_ONLY"*"$NOTHING_DELETED"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - reset-node did not name the signing record of IDENTITY_FILE";; esac
case "$LAST_OUT" in *"$W/node/validator.key "*) FAIL=$((FAIL + 1)); echo "FAIL - reset-node named an IDENTITY_FILE that does not exist";; esac

new_reset_world
mkdir -p "$W/keys"
echo validator.key >"$W/keys/validator.key"
echo record >"$W/keys/validator.key.signed.json"
IDENTITY_FILE="$W/keys/validator.key" reset_check "reset-node: IDENTITY_FILE and its signing record outside the checkout -> proceeds" ok -y
[[ -f "$W/keys/validator.key" && -f "$W/keys/validator.key.signed.json" ]] || { FAIL=$((FAIL + 1)); echo "FAIL - reset-node touched the IDENTITY_FILE outside the checkout"; }

new_reset_world
IDENTITY_FILE=.demos_identity reset_check "reset-node: IDENTITY_FILE=.demos_identity -> proceeds, keeps it and its files" ok -y
for f in .demos_identity "${RESET_SIGNING[@]}"; do
    [[ -f "$W/node/$f" ]] || { FAIL=$((FAIL + 1)); echo "FAIL - reset-node with IDENTITY_FILE=.demos_identity dropped $f"; }
done

# A node started from this checkout without docker or a lock: a bun or node
# process working in it (here a shell script named bun that sleeps: a copy of
# sleep would not do, as a multi-call coreutils refuses to run as bun).
# reset-node and the processes that started it do not count. A case fails
# when its fake bun is not running before and after reset-node, so a process
# that never started (or ended early) cannot make it pass
fake_bun_runs() {
    local stat comm
    kill -0 "$FAKE_BUN" 2>/dev/null || return 1
    read -r stat comm < <(ps -o stat= -o comm= -p "$FAKE_BUN" 2>/dev/null)
    [[ "$stat" != Z* && "${comm##*/}" == bun ]]
}
kill_fake_bun() { kill "$FAKE_BUN" 2>/dev/null; wait "$FAKE_BUN" 2>/dev/null; }
# start_fake_bun DIR NAME: returns 1, failing NAME, if it is not running
start_fake_bun() {
    mkdir -p "$W/fake" "$1"
    cat >"$W/fake/bun" <<'EOF'
#!/bin/sh
# Stays alive under the name bun (no exec) in the directory it was started
# in; ends its sleep when it is stopped
sleep "$1" &
trap 'kill $!' TERM
wait
EOF
    chmod +x "$W/fake/bun"
    (cd "$1" && exec "$W/fake/bun" 60) &
    FAKE_BUN=$!
    local i
    for ((i = 0; i < 50; i++)); do
        fake_bun_runs && return 0
        "$REAL_SLEEP" 0.1
    done
    kill_fake_bun
    FAIL=$((FAIL + 1))
    echo "FAIL - $2: the fake bun process is not running"
    return 1
}
# stop_fake_bun NAME: fails NAME if the fake bun ended before it was stopped
stop_fake_bun() {
    fake_bun_runs || { FAIL=$((FAIL + 1)); echo "FAIL - $1: the fake bun process ended before it was stopped"; }
    kill_fake_bun
}
if [[ -e "/proc/$$/cwd" ]]; then
    new_reset_world
    if start_fake_bun "$W/node" "reset-node with a bun process in this checkout"; then
        reset_check "reset-node: a bun process works in this checkout -> refuses, deletes nothing" fail -y
        stop_fake_bun "reset-node with a bun process in this checkout"
        expect_untouched "reset-node with a bun process in this checkout"
        case "$LAST_OUT" in *"Process $FAKE_BUN (bun) is running in this checkout: $W/node"*"Stop what is named above"*"$NOTHING_DELETED"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - reset-node did not name the bun process in this checkout";; esac
    fi

    # bash copied under the name bun runs reset-node from the checkout; it
    # stops if it does not run under the name bun
    new_reset_world
    mkdir -p "$W/fake"
    cp "$(command -v bash)" "$W/fake/bun"
    out="$(cd "$W/node" && env PATH="$W/bin:$PATH" STUB_REAL_MV="$(command -v mv)" STUB_RESET_DIR="$W" \
        timeout 60 "$W/fake/bun" -c 'c="$(ps -o comm= -p $$)"; [[ "${c##*/}" == bun ]] || { echo "the fake bun process runs as ${c:-nothing}"; exit 99; }; "$0" -y; exit $?' "$W/reset-node" 2>&1)"
    rc=$?
    reset_result "reset-node: started by a bun process working in this checkout -> proceeds" ok "$rc" "$out"
else
    echo "skip - reset-node with a bun process in this checkout: no /proc on this host"
fi
new_reset_world
if start_fake_bun "$W/node-old" "reset-node with a bun process outside this checkout"; then
    reset_check "reset-node: a bun process works outside this checkout (a sibling with the same prefix) -> proceeds" ok -y
    stop_fake_bun "reset-node with a bun process outside this checkout"
fi

# A link that cannot be followed hides where the lock is: refuse
new_reset_world
rm -f "$W/node/.demos_identity"
ln -s loop-b "$W/node/.demos_identity"
ln -s .demos_identity "$W/node/loop-b"
reset_check "reset-node: .demos_identity is a link loop -> refuses, deletes nothing" fail -y
[[ -f "$W/node/package.json" && -L "$W/node/.demos_identity" ]] || { FAIL=$((FAIL + 1)); echo "FAIL - reset-node with a link loop: the node directory was changed"; }
if compgen -G "$W/*.backup" >/dev/null; then FAIL=$((FAIL + 1)); echo "FAIL - reset-node with a link loop: backups were made"; fi
case "$LAST_OUT" in *".demos_identity is a link that cannot be followed"*"$NOTHING_DELETED"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - reset-node did not say the identity link cannot be followed";; esac

# A lock that gives neither pid nor host may still be held (another user's
# node writes it 0600; a starting node creates it before it writes it): refuse
expect_unread_lock() {
    local what="$1"
    expect_untouched "$what"
    [[ -e "$W/node/.demos_identity.lock" ]] || { FAIL=$((FAIL + 1)); echo "FAIL - $what: the lock was removed"; }
    case "$LAST_OUT" in *"Could not read the identity lock $W/node/.demos_identity.lock"*"If no node uses this checkout, remove the lock file and run reset-node again. $NOTHING_DELETED."*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - $what: reset-node did not name the lock it could not read";; esac
}
# each lock below would let the reset go on if it were read
new_reset_world
write_lock "$DEAD_PID" "$THIS_HOST" 1000
chmod 000 "$W/node/.demos_identity.lock"
if [[ -r "$W/node/.demos_identity.lock" ]]; then
    echo "skip - reset-node with a lock it cannot read: running as root, which reads a mode 000 file"
else
    reset_check "reset-node: identity lock it cannot read (mode 000) -> refuses, deletes nothing" fail -y
    expect_unread_lock "reset-node with a lock it cannot read"
fi
chmod 600 "$W/node/.demos_identity.lock"

# A lock in a directory this user cannot search looks absent: refuse
new_reset_world
mkdir -p "$W/state"
mv "$W/node/.demos_identity" "$W/state/.demos_identity"
ln -s "$W/state/.demos_identity" "$W/node/.demos_identity"
write_lock "$$" "$THIS_HOST" "$(($(date +%s) * 1000))" "$W/state/.demos_identity.lock"
chmod 000 "$W/state"
if [[ -x "$W/state" ]]; then
    echo "skip - reset-node with a lock in a directory it cannot search: running as root, which searches a mode 000 directory"
else
    reset_check "reset-node: fresh lock in a directory it cannot search (mode 000) -> refuses, deletes nothing" fail -y
    chmod 700 "$W/state"
    expect_untouched "reset-node with a lock in a directory it cannot search"
    case "$LAST_OUT" in *"Cannot look for the identity lock $W/state/.demos_identity.lock: $W/state cannot be searched"*"$NOTHING_DELETED"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - reset-node did not name the directory it cannot search";; esac
fi
chmod 700 "$W/state"

# cat prints the lock, then fails: the failed read counts, not what it printed
new_reset_world
write_lock "$DEAD_PID" "$THIS_HOST" 1000
printf '#!/usr/bin/env bash\nif [[ "${1:-}" == *.lock ]]; then %q "$@"; echo "cat: read error: Input/output error" >&2; exit 1; fi\nexec %q "$@"\n' "$(command -v cat)" "$(command -v cat)" >"$W/bin/cat"
chmod +x "$W/bin/cat"
reset_check "reset-node: reading the identity lock fails after printing it -> refuses, deletes nothing" fail -y
expect_unread_lock "reset-node with a failed lock read"

new_reset_world
: >"$W/node/.demos_identity.lock"
reset_check "reset-node: empty identity lock -> refuses, deletes nothing" fail -y
expect_unread_lock "reset-node with an empty lock"

new_reset_world
echo 'not a lock' >"$W/node/.demos_identity.lock"
reset_check "reset-node: identity lock with no pid or hostname -> refuses, deletes nothing" fail -y
expect_unread_lock "reset-node with a lock that is not a node lock"

# A lock read while the node is still writing it: only a whole object with
# both pid and hostname counts as read
new_reset_world
printf '{"pid":%s,' "$DEAD_PID" >"$W/node/.demos_identity.lock"
reset_check "reset-node: identity lock cut off after its pid -> refuses, deletes nothing" fail -y
expect_unread_lock "reset-node with a lock cut off after its pid"

new_reset_world
printf '{"pid":%s,"hostname":"%s"' "$DEAD_PID" "$THIS_HOST" >"$W/node/.demos_identity.lock"
reset_check "reset-node: identity lock with pid and hostname but no closing brace -> refuses, deletes nothing" fail -y
expect_unread_lock "reset-node with a lock without its closing brace"

new_reset_world
write_lock "$DEAD_PID" "$THIS_HOST" 1000
reset_check "reset-node: lock left by a node that is gone -> proceeds" ok -y

new_reset_world
printf '\n {"pid":%s,"hostname":"%s","instance":"0f0e","seq":3,"heartbeat":1000} \n\n' "$DEAD_PID" "$THIS_HOST" >"$W/node/.demos_identity.lock"
reset_check "reset-node: whole lock with whitespace around it, left by a node that is gone -> proceeds" ok -y

new_reset_world
export STUB_DOCKER_DOWN=1
reset_check "reset-node: docker not reachable, no lock -> says so, proceeds" ok -y
case "$LAST_OUT" in *"docker is not reachable"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - reset-node did not say docker is not reachable";; esac

new_reset_world
write_lock "$$" "$THIS_HOST" "$(($(date +%s) * 1000))"
reset_check "reset-node: docker not reachable, lock held -> refuses" fail -y
unset STUB_DOCKER_DOWN
expect_untouched "reset-node with docker unreachable and a held lock"

# A daemon or context that never answers: after 10s the query is killed, and
# reset-node says docker is not reachable and still checks the lock
new_reset_world
write_old_lock "$$" "$THIS_HOST"
export STUB_DOCKER_HANG=1
started=$SECONDS
reset_check "reset-node: docker ps never answers, lock held -> stops waiting after 10s, refuses" fail -y
took=$((SECONDS - started))
unset STUB_DOCKER_HANG
expect_untouched "reset-node with a docker that never answers and a held lock"
((took < 20)) || { FAIL=$((FAIL + 1)); echo "FAIL - reset-node waited ${took}s for a docker ps that never answers"; }
case "$LAST_OUT" in *"docker is not reachable"*"Identity lock $W/node/.demos_identity.lock is held"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - reset-node did not fall back to the lock check when docker ps never answered";; esac
if [[ -s "$W/docker.pid" ]] && kill -0 "$(cat "$W/docker.pid")" 2>/dev/null; then FAIL=$((FAIL + 1)); echo "FAIL - reset-node left the docker ps that never answered running"; fi

# The container list goes through a temporary file: without one, reset-node
# stops instead of skipping the container check
new_reset_world
TMPDIR="$W/missing" reset_check "reset-node: no temporary file for the container list -> refuses, deletes nothing" fail -y
expect_untouched "reset-node without a temporary file"
case "$LAST_OUT" in *"Could not create a temporary file in $W/missing"*"$NOTHING_DELETED"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - reset-node did not say it could not create a temporary file";; esac

# A node that starts after the first check (a supervisor restarting it while
# the prompt waits, a container coming up after the backup): reset-node checks
# again before the backup and again before the removal
new_reset_world
reset_prompt_check "reset-node: nothing starts while the prompt waits, y typed -> completes" ok true
[[ -f "$W/node/.demos_identity.commitlock.json" ]] || { FAIL=$((FAIL + 1)); echo "FAIL - reset-node after the prompt dropped the commit lock"; }

write_fresh_lock() { write_lock "$$" "$THIS_HOST" "$(($(date +%s) * 1000))"; }
new_reset_world
reset_prompt_check "reset-node: a node takes the identity lock while the prompt waits, y typed -> refuses, deletes nothing" fail write_fresh_lock
expect_untouched "reset-node with a lock taken while the prompt waits"
[[ -f "$W/node/.demos_identity.lock" ]] || { FAIL=$((FAIL + 1)); echo "FAIL - reset-node removed the lock taken while the prompt waited"; }
case "$LAST_OUT" in *"WARNING: This will delete"*"Identity lock $W/node/.demos_identity.lock is held"*"$NOTHING_DELETED"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - reset-node did not name the lock taken while the prompt waited";; esac
case "$LAST_OUT" in *"Removing old node directory"*) FAIL=$((FAIL + 1)); echo "FAIL - reset-node went on to the removal with the lock held";; esac

new_reset_world
IDENTITY_FILE=validator.key reset_prompt_check "reset-node: the IDENTITY_FILE is made in the checkout while the prompt waits, y typed -> refuses, deletes nothing" fail touch "$W/node/validator.key"
expect_untouched "reset-node with an IDENTITY_FILE made while the prompt waits"
case "$LAST_OUT" in *"WARNING: This will delete"*"$W/node/validator.key (of IDENTITY_FILE=validator.key) is in this checkout"*"$KEEPS_ONLY"*"$NOTHING_DELETED"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - reset-node did not name the IDENTITY_FILE made while the prompt waited";; esac

new_reset_world
export STUB_PS="demos-node $W/node\n" STUB_PS_FROM=2
reset_check "reset-node -y: a container of this checkout starts after the first check -> refuses before the backup" fail -y
unset STUB_PS STUB_PS_FROM
expect_untouched "reset-node with a container started after the first check"

# docker ps calls: the first check, the one before the backup, the one before the removal
new_reset_world
export STUB_PS="demos-node $W/node\n" STUB_PS_FROM=3
reset_check "reset-node -y: a container of this checkout starts between backup and removal -> refuses, keeps checkout and backups" fail -y
unset STUB_PS STUB_PS_FROM
[[ "$(grep -c '^docker ps' "$W/docker.log")" == 3 ]] || { FAIL=$((FAIL + 1)); echo "FAIL - reset-node did not list the containers again before the removal"; }
[[ -f "$W/node/package.json" && -f "$W/node/.demos_identity" && -f "$W/node/.demos_identity.commitlock.json" ]] \
    || { FAIL=$((FAIL + 1)); echo "FAIL - reset-node with a container started after the backup: the node directory was changed"; }
for f in .demos_identity "${RESET_SIGNING[@]}"; do
    [[ -f "$W/$f.backup" ]] || { FAIL=$((FAIL + 1)); echo "FAIL - reset-node with a container started after the backup: no backup of $f left"; }
done
case "$LAST_OUT" in *"Container demos-node of this checkout"*"$NOTHING_DELETED"*"backups made so far are left in place"*"$W/.demos_identity.commitlock.json.backup"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - reset-node did not say where the backups made before the refusal are";; esac

new_reset_world
rm -f "$W/bin/docker"
if PATH="$W/bin:$PATH" command -v docker >/dev/null 2>&1; then
    echo "skip - reset-node without docker installed: this host has docker"
else
    reset_check "reset-node: docker not installed, no lock -> says so, proceeds" ok -y
    case "$LAST_OUT" in *"docker is not installed"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - reset-node did not say docker is not installed";; esac
fi

new_reset_world
reset_check "reset-node --wipe-signing-state: completes" ok -y --wipe-signing-state
[[ -f "$W/node/.demos_identity" ]] || { FAIL=$((FAIL + 1)); echo "FAIL - reset-node --wipe-signing-state dropped the identity"; }
for f in "${RESET_SIGNING[@]}"; do
    [[ -e "$W/node/$f" ]] && { FAIL=$((FAIL + 1)); echo "FAIL - reset-node --wipe-signing-state kept $f"; }
done

# The clone fails and a backup cannot be moved back: the operator must be told
# where it is, or the signing record is silently left behind
new_reset_world
export STUB_FAIL_CLONE=1 STUB_FAIL_MV=1
reset_check "reset-node: clone fails, restore fails -> exits non-zero" fail -y
unset STUB_FAIL_CLONE STUB_FAIL_MV
[[ -f "$W/.demos_identity.commitlock.json.backup" ]] || { FAIL=$((FAIL + 1)); echo "FAIL - reset-node lost the commit lock backup"; }
case "$LAST_OUT" in *"$W/.demos_identity.commitlock.json.backup"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - reset-node did not say where the unrestored commit lock backup is";; esac

# The clone works but a backup cannot be moved back, or is gone: the node must
# not be reported ready to start without its signing state
new_reset_world
export STUB_FAIL_MV=1
reset_check "reset-node: restore fails after a clean clone -> exits non-zero" fail -y
unset STUB_FAIL_MV
[[ -f "$W/.demos_identity.commitlock.json.backup" ]] || { FAIL=$((FAIL + 1)); echo "FAIL - reset-node lost the commit lock backup after a failed restore"; }
case "$LAST_OUT" in *"$W/.demos_identity.commitlock.json.backup"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - reset-node did not say where the unrestored commit lock backup is";; esac
case "$LAST_OUT" in *"reset complete"*) FAIL=$((FAIL + 1)); echo "FAIL - reset-node reported success after a failed restore";; esac

new_reset_world
export STUB_DROP_BACKUP=.demos_identity.signed.json.halted
reset_check "reset-node: a backup is missing at restore -> exits non-zero" fail -y
unset STUB_DROP_BACKUP
case "$LAST_OUT" in *"$W/.demos_identity.signed.json.halted.backup"*) ;; *) FAIL=$((FAIL + 1)); echo "FAIL - reset-node did not name the missing halt marker backup";; esac
case "$LAST_OUT" in *"reset complete"*) FAIL=$((FAIL + 1)); echo "FAIL - reset-node reported success with a backup missing";; esac

echo
echo "passed: $PASS  failed: $FAIL"
exit "$FAIL"
