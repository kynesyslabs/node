#!/usr/bin/env bash
# Stub-based test of the PG_PORT that scripts/run hands to the node.
#
# With the bundled PostgreSQL the launcher owns the port: 5332, or the -d value.
# With an external database (-e) the port is the operator's: the -d value, else
# PG_PORT from the shell, else nothing is exported and the node reads .env (or its
# own default). docker, bun, nc ... are stubbed (no Docker, no Postgres, no
# network). The bun stub prints the PG_PORT the node would start with, and, as
# dotenv does, takes it from ./.env only when the environment has none.
#
# Checks:
#   - -e with PG_PORT in .env only -> the node gets the .env value
#   - -e with PG_PORT in the shell (and .env) -> the shell value
#   - -e -d <port> -> the flag value, over the shell and .env
#   - --external-db -d <port> -> the flag value (short options after a long one are read)
#   - -e with no PG_PORT anywhere -> nothing exported, the node's default applies
#   - the banner names the PG_* variables, not DATABASE_URL, and the database host/port
#   - without -e: 5332, or -d, whatever the shell or .env carry (unchanged)
#
# Usage:
#   scripts/launcher-external-db.test.sh                 # the scripts next to this file
#   SCRIPTS_DIR=/path/to/old/scripts scripts/launcher-external-db.test.sh
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

    # `bun start:bun`: report the PG_PORT the node would use
    cat >"$bin/bun" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
--version) echo 1.0.0 ;;
start:bun | run)
    port="${PG_PORT-}"
    if [[ -z "${PG_PORT+x}" && -f .env ]]; then
        port="$(sed -n 's/^PG_PORT=//p' .env | tail -1)"
    fi
    echo "NODE PG_PORT=${port:-5332 (node default)} exported=${PG_PORT+yes}" >>"$STUB_ST/node.log"
    ;;
esac
exit 0
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
    printf '#!/usr/bin/env bash\nexit 0\n' >"$bin/sleep"
    printf '#!/usr/bin/env bash\necho 8\n' >"$bin/nproc"
    chmod +x "$bin"/*
}

new_world() {
    N=$((N + 1))
    W="$ROOT/w$N"
    ST="$W/.stub"
    mkdir -p "$W/scripts" "$W/postgres" "$ST"
    cp "$SRC/run" "$W/scripts/run" || { echo "missing $SRC/run" >&2; exit 99; }
    chmod +x "$W/scripts/run"
    : >"$W/postgres/docker-compose.yml"
    printf 'MIN_RAM=0\nSUGGESTED_RAM=0\n' >"$W/.requirements"
    make_stubs "$W/bin"
}

# check NAME WANT_PORT [ENV_VAR=value ...] -- ARGS...   (.env content from DOTENV)
# WANT_PORT is what the node must start with; DotEnv is written when DOTENV is set
check() {
    local name="$1" want="$2"
    shift 2
    local envs=()
    while [[ "${1:-}" != "--" ]]; do envs+=("$1"); shift; done
    shift
    new_world
    [[ -n "${DOTENV:-}" ]] && printf '%s\n' "$DOTENV" >"$W/.env"
    OUT="$(cd "$W" && env -u PG_PORT -u PG_HOST PATH="$W/bin:$PATH" STUB_ST="$ST" GOSSIP_ENABLED=false \
        "${envs[@]}" timeout 60 "$W/scripts/run" "$@" -t -m 2>&1)"
    local got
    got="$(sed -n 's/^NODE PG_PORT=\([^ ]*\).*/\1/p' "$ST/node.log" 2>/dev/null | tail -1)"
    if [[ "$got" == "$want" ]]; then
        PASS=$((PASS + 1))
        echo "ok   - $name (node PG_PORT=$got)"
    else
        FAIL=$((FAIL + 1))
        echo "FAIL - $name: node PG_PORT=${got:-<node never started>} (want $want)"
        echo "$OUT" | tail -6 | sed 's/^/         | /'
    fi
}

expect_banner() {
    local name="$1" pattern="$2" absent="${3:-}"
    if grep -q -- "$pattern" <<<"$OUT" && { [[ -z "$absent" ]] || ! grep -q -- "$absent" <<<"$OUT"; }; then
        PASS=$((PASS + 1))
        echo "ok   - $name"
    else
        FAIL=$((FAIL + 1))
        echo "FAIL - $name (want /$pattern/, not /$absent/)"
        echo "$OUT" | sed -n '/Node Configuration/,/Display/p' | sed 's/^/         | /'
    fi
}

echo "# scripts/run, external database (scripts from: $SRC)"
DOTENV='PG_PORT=5433'
check "-e, PG_PORT only in .env -> the .env value" 5433 -- -e
DOTENV='PG_PORT=5433'
check "-e, PG_PORT in the shell and .env -> the shell value" 5434 PG_PORT=5434 -- -e
DOTENV='PG_PORT=5433'
check "-e -d 5435, shell and .env differ -> the flag value" 5435 PG_PORT=5434 -- -e -d 5435
DOTENV='PG_PORT=5433'
check "--external-db, PG_PORT only in .env -> the .env value" 5433 -- --external-db
DOTENV='PG_PORT=5433'
check "--external-db -d 5435, shell and .env differ -> the flag value" 5435 PG_PORT=5434 -- --external-db -d 5435
DOTENV=''
check "-e, no PG_PORT anywhere -> nothing exported, node default" 5332 -- -e
if grep -q 'exported=yes' "$ST/node.log"; then FAIL=$((FAIL + 1)); echo "FAIL - -e with no PG_PORT exported one anyway"; else PASS=$((PASS + 1)); echo "ok   - -e with no PG_PORT exports none"; fi
DOTENV='PG_PORT=5433'
check "-e banner names the PG_* variables" 5433 PG_HOST=db.example -- -e
expect_banner "-e banner: PG_* variables, database host and port, no DATABASE_URL" 'Database: host db.example, port (PG_PORT from .env' 'DATABASE_URL'
expect_banner "-e banner: mode line names PG_PORT" 'External database (PG_HOST, PG_PORT'
check "-e -d 5435 banner shows the flag port" 5435 -- -e -d 5435
expect_banner "-e -d banner: port 5435" 'Database: host .*, port 5435'
if bash "$SRC/run" -h 2>&1 | grep -q DATABASE_URL; then
    FAIL=$((FAIL + 1)); echo "FAIL - help still names DATABASE_URL"
else
    PASS=$((PASS + 1)); echo "ok   - help does not name DATABASE_URL"
fi

echo "# scripts/run, bundled PostgreSQL (unchanged)"
DOTENV='PG_PORT=5433'
check "no -e: 5332 whatever the shell and .env carry" 5332 PG_PORT=5434 --
DOTENV='PG_PORT=5433'
check "no -e -d 5333: the flag value" 5333 PG_PORT=5434 -- -d 5333
expect_banner "no -e banner: Database Port 5333" 'Database Port: 5333'

echo
echo "passed $PASS, failed $FAIL"
exit "$FAIL"
