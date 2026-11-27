#!/usr/bin/env bash
# Stub-based test of scripts/docker-run's .demos_identity sync into the node
# state volume (no Docker). The docker stub keeps each volume as a directory
# and runs a `docker run ... alpine sh -c SCRIPT` on the host, with every mount
# point in SCRIPT rewritten to the volume directory or the bind-mounted file.
#
# Checks, for `up`:
#   - an empty volume gets the host identity, mode 0600, through a temp file
#     that is synced and then renamed into place; a seed cut short or not
#     synced leaves no identity, and after a cut-short one the next `up`
#     seeds the host identity
#   - a volume identity equal to the host one, a leading UTF-8 BOM and leading
#     and trailing whitespace (CRLF, a trailing space) aside, starts and is
#     left as it was
#   - a volume identity that differs from the host one, also only in the
#     spacing between words, stops before compose runs, leaves the volume
#     copy as it was, and names the way out
#   - a host or volume identity the sync container cannot read stops before
#     compose runs, with --clean before anything is downed or removed, and
#     says which file it could not read
#   - with --clean, a different identity stops before anything is downed or
#     removed, and an equal one is wiped and started as before
#   - with --rebuild, a different identity stops before the image is built or
#     the build cache pruned, and an equal one is built and started
#   - the printed command that moves the volume's identity aside succeeds on
#     a first swap, on a second swap (keeping the first one set aside), and
#     without signing-state files, after which `up` seeds the host identity;
#     interrupted, it leaves the identity in the volume and `up` refuses
#   - without a host identity the volume copy is used as it is
#   - a --port instance compares against its own state volume
#   - a failed sync container stops before compose runs
# and that `down` never compares.
#
# Usage:
#   scripts/docker-run-identity.test.sh
#   SCRIPTS_DIR=/path/to/old/scripts scripts/docker-run-identity.test.sh
# Exit status is the number of failed checks (0 = all passed).

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${SCRIPTS_DIR:-$HERE}"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

PASS=0
FAIL=0
N=0

KEY_A="abandon ability able about above absent absorb abstract absurd abuse access accident"
KEY_B="zoo zone youth young yellow year wrong wrist write world worth worry"
KEY_C="legal winner thank year wave sausage worth useful legal winner thank yellow"

make_stubs() {
    local bin="$1"
    mkdir -p "$bin"
    cat >"$bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >>"$STUB_ST/calls.log"
case "${1:-}" in
volume)
    case "${2:-}" in
    inspect) [[ -d "$STUB_ST/vol/$3" ]]; exit $? ;;
    create) mkdir -p "$STUB_ST/vol/$3"; exit 0 ;;
    esac
    exit 0 ;;
run)
    [[ "${STUB_FAIL_RUN:-0}" == 1 ]] && { echo "Unable to find image 'alpine:latest'" >&2; exit 125; }
    # run --rm -v SRC:DST[:ro]... IMAGE sh -c SCRIPT
    shift
    mounts=()
    while [[ $# -gt 0 ]]; do
        case "$1" in
        --rm) shift ;;
        -v) mounts+=("$2"); shift 2 ;;
        *) break ;;
        esac
    done
    shift
    [[ "${1:-}" == sh && "${2:-}" == -c ]] || exit 0
    script="$3"
    for m in ${mounts[@]+"${mounts[@]}"}; do
        src="${m%%:*}"
        dst="${m#*:}"
        dst="${dst%%:*}"
        [[ "$src" == /* ]] || src="$STUB_ST/vol/$src"
        script="${script//"$dst"/"$src"}"
    done
    exec sh -c "$script" ;;
compose)
    # --clean's empty-database probe: no tables
    [[ " $* " == *" exec "* ]] && echo 0
    exit 0 ;;
*) exit 0 ;;
esac
EOF
    # the sync container runs as root; the host user cannot chown to uid 1000
    printf '#!/usr/bin/env bash\nexit 0\n' >"$bin/chown"
    # sync keeps what the volume holds when the seed is flushed: the temp
    # file's content, and whether the identity is already in place
    cat >"$bin/sync" <<'EOF'
#!/usr/bin/env bash
for d in "$STUB_ST"/vol/*/; do
    [[ ! -e "$d.demos_identity" ]] || : >"$STUB_ST/identity-at-sync"
    [[ ! -e "$d.seed.tmp" ]] || cat "$d.seed.tmp" >"$STUB_ST/synced"
done
[[ "${STUB_FAIL_SYNC:-0}" != 1 ]]
EOF
    chmod +x "$bin"/*
}

new_world() {
    N=$((N + 1))
    W="$ROOT/w$N"
    ST="$W/.stub"
    mkdir -p "$W/scripts" "$ST/vol"
    cp "$SRC/docker-run" "$W/scripts/docker-run" || { echo "missing $SRC/docker-run" >&2; exit 99; }
    chmod +x "$W/scripts/docker-run"
    : >"$W/docker-compose.yml"
    make_stubs "$W/bin"
    unset STUB_FAIL_RUN
}

# seed_volume VOLUME CONTENT: the identity a node in that volume already runs
seed_volume() {
    mkdir -p "$ST/vol/$1"
    printf '%s' "$2" >"$ST/vol/$1/.demos_identity"
    cp "$ST/vol/$1/.demos_identity" "$ST/before"
}

# unreadable FILE: the sync container cannot read FILE (SELinux labels,
# userns-remap). Root reads a mode-000 file, so a cat stub stands in for it.
unreadable() {
    chmod 000 "$1"
    [[ -r "$1" ]] || return 0
    printf '#!/usr/bin/env bash\n[[ "$1" == %q ]] && { echo "cat: Permission denied" >&2; exit 1; }\nexec %q "$@"\n' \
        "$1" "$(command -v cat)" >"$W/bin/cat"
    chmod +x "$W/bin/cat"
}

docker_run() {
    OUT="$(cd "$W" && env PATH="$W/bin:$PATH" STUB_ST="$ST" timeout 60 "$W/scripts/docker-run" "$@" 2>&1)"
    RC=$?
}

# move_aside: runs, as an operator would paste it, the `docker run` command
# the refused `up` printed to move the volume's identity aside
move_aside() {
    local cmd
    cmd="$(printf '%s\n' "$OUT" | grep -E '^ +docker run ' | sed 's/^ *//')"
    [[ -n "$cmd" ]] || { OUT="no command printed"; RC=98; return; }
    OUT="$(cd "$W" && env PATH="$W/bin:$PATH" STUB_ST="$ST" timeout 60 bash -c "$cmd" 2>&1)"
    RC=$?
}

# aside N FILE CONTENT: the Nth folder set aside in the volume (oldest first)
# holds FILE with CONTENT
aside() {
    local d
    d="$(ls -d "$ST/vol/demos_node_state/previous-identity"/*/ 2>/dev/null | sed -n "${1}p")"
    [[ -n "$d" && -f "$d$2" && "$(cat "$d$2")" == "$3" ]]
}

expect() {
    local name="$1"
    shift
    if "$@"; then
        PASS=$((PASS + 1))
        echo "ok   - $name"
    else
        FAIL=$((FAIL + 1))
        echo "FAIL - $name (exit $RC)"
        echo "$OUT" | tail -8 | sed 's/^/         | /'
    fi
}

started() { grep -qE '^docker compose .* up( |$)' "$ST/calls.log"; }
not_started() { ! started; }
# the final `up -d`, not --clean's `up -d --wait ... postgres`
started_node() { grep -qE '^docker compose .* up -d$' "$ST/calls.log"; }
not_downed() { ! grep -qE '^docker compose .* down( |$)' "$ST/calls.log"; }
no_volume_removed() { ! grep -q '^docker volume rm ' "$ST/calls.log"; }
built() { grep -qE '^docker compose .* build --no-cache( |$)' "$ST/calls.log"; }
not_built() { ! built; }
not_pruned() { ! grep -q '^docker builder prune' "$ST/calls.log"; }
removed() { grep -qx "docker volume rm $1" "$ST/calls.log"; }
unchanged() { cmp -s "$ST/before" "$ST/vol/$1/.demos_identity"; }
says() { [[ "$OUT" == *"$1"* ]]; }
not_says() { ! says "$1"; }

echo "# scripts/docker-run identity sync (scripts from: $SRC)"

new_world
printf '%s\n' "$KEY_A" >"$W/.demos_identity"
docker_run up -d
expect "empty volume: starts" test "$RC" -eq 0
expect "empty volume: gets the host identity" cmp -s "$W/.demos_identity" "$ST/vol/demos_node_state/.demos_identity"
expect "empty volume: the copy is 0600" test "$(stat -c %a "$ST/vol/demos_node_state/.demos_identity")" = 600
expect "empty volume: compose up runs" started
expect "empty volume: the whole copy is synced" cmp -s "$W/.demos_identity" "$ST/synced"
expect "empty volume: the identity is renamed into place after the sync" test ! -e "$ST/identity-at-sync"
expect "empty volume: no temp file is left" test ! -e "$ST/vol/demos_node_state/.seed.tmp"

# a seed cut short (power loss, a full disk) leaves no identity in the volume,
# so the next `up` seeds the host identity instead of refusing a partial one
new_world
printf '%s\n' "$KEY_A" >"$W/.demos_identity"
printf '#!/usr/bin/env bash\n[[ "$1" == */.demos_identity ]] && { head -c 18 "$1" >"$2"; echo "cp: write error" >&2; exit 1; }\nexec %q "$@"\n' \
    "$(command -v cp)" >"$W/bin/cp"
chmod +x "$W/bin/cp"
docker_run up -d
rm -f "$W/bin/cp"
expect "seed cut short: refuses" test "$RC" -ne 0
expect "seed cut short: compose up never runs" not_started
expect "seed cut short: the volume holds no identity" test ! -e "$ST/vol/demos_node_state/.demos_identity"
docker_run up -d
expect "seed cut short: the next up starts" test "$RC" -eq 0
expect "seed cut short: the next up seeds the host identity" cmp -s "$W/.demos_identity" "$ST/vol/demos_node_state/.demos_identity"
expect "seed cut short: no temp file is left" test ! -e "$ST/vol/demos_node_state/.seed.tmp"

# a seed whose sync fails is not renamed into place
new_world
printf '%s\n' "$KEY_A" >"$W/.demos_identity"
export STUB_FAIL_SYNC=1
docker_run up -d
unset STUB_FAIL_SYNC
expect "seed not synced: refuses" test "$RC" -ne 0
expect "seed not synced: compose up never runs" not_started
expect "seed not synced: the volume holds no identity" test ! -e "$ST/vol/demos_node_state/.demos_identity"

new_world
seed_volume demos_node_state "$KEY_A"
printf '%s\n' "$KEY_A" >"$W/.demos_identity"
docker_run up -d
expect "same identity: starts" test "$RC" -eq 0
expect "same identity: the volume copy is left as it was" unchanged demos_node_state
expect "same identity: compose up runs" started

new_world
seed_volume demos_node_state "$KEY_A"
printf '%s\n' "$KEY_B" >"$W/.demos_identity"
docker_run up -d
expect "different identity: refuses" test "$RC" -eq 1
expect "different identity: the volume copy is left as it was" unchanged demos_node_state
expect "different identity: compose up never runs" not_started
expect "different identity: names the volume" says "demos_node_state"
expect "different identity: names the host file" says "$W/.demos_identity"
expect "different identity: names both ways out" says "move $W/.demos_identity"
expect "different identity: says the files differ" says "$W/.demos_identity and the .demos_identity in volume demos_node_state differ after trimming whitespace"
expect "different identity: same mnemonic keeps the volume's identity" says "If both hold the same mnemonic, keep the volume's identity"

# The node trims the identity file when it reads it: leading and trailing
# whitespace is the same key
new_world
seed_volume demos_node_state "$KEY_A"
printf '%s\r\n' "$KEY_A" >"$W/.demos_identity"
docker_run up -d
expect "same identity, CRLF: starts" test "$RC" -eq 0
expect "same identity, CRLF: the volume copy is left as it was" unchanged demos_node_state
expect "same identity, CRLF: compose up runs" started

new_world
seed_volume demos_node_state "$KEY_A"
printf '%s \n' "$KEY_A" >"$W/.demos_identity"
docker_run up -d
expect "same identity, trailing space: starts" test "$RC" -eq 0
expect "same identity, trailing space: the volume copy is left as it was" unchanged demos_node_state
expect "same identity, trailing space: compose up runs" started

new_world
seed_volume demos_node_state "$(printf ' \t%s\t \n\n' "$KEY_A")"
printf '%s\n' "$KEY_A" >"$W/.demos_identity"
docker_run up -d
expect "same identity, whitespace around the volume copy: starts" test "$RC" -eq 0
expect "same identity, whitespace around the volume copy: compose up runs" started

# PowerShell 5's `-Encoding UTF8` writes a BOM; the node's trim drops it
new_world
seed_volume demos_node_state "$KEY_A"
printf '\357\273\277%s\r\n' "$KEY_A" >"$W/.demos_identity"
docker_run up -d
expect "same identity, BOM on the host file: starts" test "$RC" -eq 0
expect "same identity, BOM on the host file: the volume copy is left as it was" unchanged demos_node_state
expect "same identity, BOM on the host file: compose up runs" started

new_world
seed_volume demos_node_state "$(printf '\357\273\277%s\n' "$KEY_A")"
printf '%s\n' "$KEY_A" >"$W/.demos_identity"
docker_run up -d
expect "same identity, BOM on the volume copy: starts" test "$RC" -eq 0
expect "same identity, BOM on the volume copy: compose up runs" started

# whitespace between the words is part of the key
new_world
seed_volume demos_node_state "$KEY_A"
printf '%s\r\n' "${KEY_A/ /  }" >"$W/.demos_identity"
docker_run up -d
expect "different spacing between words: refuses" test "$RC" -eq 1
expect "different spacing between words: compose up never runs" not_started
expect "different spacing between words: says the files differ" says "differ after trimming whitespace"

# a file the sync container cannot read is not an empty identity
new_world
seed_volume demos_node_state "$KEY_A"
printf '%s\n' "$KEY_A" >"$W/.demos_identity"
unreadable "$W/.demos_identity"
docker_run up -d
expect "unreadable host file: refuses" test "$RC" -eq 1
expect "unreadable host file: compose up never runs" not_started
expect "unreadable host file: the volume copy is left as it was" unchanged demos_node_state
expect "unreadable host file: says it could not read the host file" says "could not read $W/.demos_identity to compare the identities"
expect "unreadable host file: does not call it another identity" not_says "differ after trimming whitespace"

new_world
printf '%s\n' "$KEY_A" >"$W/.demos_identity"
unreadable "$W/.demos_identity"
docker_run up -d
expect "unreadable host file, empty volume: refuses" test "$RC" -eq 1
expect "unreadable host file, empty volume: compose up never runs" not_started
expect "unreadable host file, empty volume: says it could not read the host file" says "could not read $W/.demos_identity"

new_world
seed_volume demos_node_state "$KEY_A"
mkdir -p "$ST/vol/demos_pgdata" "$ST/vol/demos_node_data"
printf '%s\n' "$KEY_A" >"$W/.demos_identity"
unreadable "$W/.demos_identity"
docker_run --clean up -d
expect "--clean, unreadable host file: refuses" test "$RC" -eq 1
expect "--clean, unreadable host file: nothing is downed" not_downed
expect "--clean, unreadable host file: no volume is removed" no_volume_removed
expect "--clean, unreadable host file: says it could not read the host file" says "could not read $W/.demos_identity"

new_world
seed_volume demos_node_state "$KEY_A"
printf '%s\n' "$KEY_A" >"$W/.demos_identity"
unreadable "$ST/vol/demos_node_state/.demos_identity"
docker_run up -d
expect "unreadable volume copy: refuses" test "$RC" -eq 1
expect "unreadable volume copy: compose up never runs" not_started
expect "unreadable volume copy: says it could not read the volume copy" says "could not read the .demos_identity in volume demos_node_state"

new_world
seed_volume demos_node_state "$KEY_A"
mkdir -p "$ST/vol/demos_pgdata" "$ST/vol/demos_node_data"
printf '%s\n' "$KEY_B" >"$W/.demos_identity"
docker_run --clean up -d
expect "--clean, different identity: refuses" test "$RC" -eq 1
expect "--clean, different identity: nothing is downed" not_downed
expect "--clean, different identity: no volume is removed" no_volume_removed
expect "--clean, different identity: compose up never runs" not_started
expect "--clean, different identity: the volume copy is left as it was" unchanged demos_node_state
expect "--clean, different identity: names both ways out" says "move $W/.demos_identity"

new_world
seed_volume demos_node_state "$KEY_A"
mkdir -p "$ST/vol/demos_pgdata" "$ST/vol/demos_node_data"
printf '%s\r\n' "$KEY_A" >"$W/.demos_identity"
docker_run --clean up -d
expect "--clean, same identity: starts" test "$RC" -eq 0
expect "--clean, same identity: wipes the database volume" removed demos_pgdata
expect "--clean, same identity: wipes the data volume" removed demos_node_data
expect "--clean, same identity: compose up runs" started_node
expect "--clean, same identity: the volume copy is left as it was" unchanged demos_node_state

# --rebuild builds with --no-cache and prunes the build cache before the sync
new_world
seed_volume demos_node_state "$KEY_A"
printf '%s\n' "$KEY_B" >"$W/.demos_identity"
docker_run --rebuild -d
expect "--rebuild, different identity: refuses" test "$RC" -eq 1
expect "--rebuild, different identity: nothing is built" not_built
expect "--rebuild, different identity: the build cache is not pruned" not_pruned
expect "--rebuild, different identity: compose up never runs" not_started
expect "--rebuild, different identity: says the files differ" says "differ after trimming whitespace"

new_world
seed_volume demos_node_state "$KEY_A"
printf '%s\n' "$KEY_A" >"$W/.demos_identity"
docker_run --rebuild -d
expect "--rebuild, same identity: starts" test "$RC" -eq 0
expect "--rebuild, same identity: builds" built
expect "--rebuild, same identity: compose up runs" started_node

new_world
seed_volume demos_node_state "$KEY_A"
printf '%s' "signed by A" >"$ST/vol/demos_node_state/.demos_identity.signed.json"
printf '%s\n' "$KEY_B" >"$W/.demos_identity"
docker_run up -d
move_aside
expect "set aside, first swap: the printed command succeeds" test "$RC" -eq 0
expect "set aside, first swap: the identity is set aside" aside 1 .demos_identity "$KEY_A"
expect "set aside, first swap: its signing state goes with it" aside 1 .demos_identity.signed.json "signed by A"
expect "set aside, first swap: no signing state is left behind" test ! -e "$ST/vol/demos_node_state/.demos_identity.signed.json"
docker_run up -d
expect "set aside, first swap: up then starts" started
expect "set aside, first swap: with the host identity" cmp -s "$W/.demos_identity" "$ST/vol/demos_node_state/.demos_identity"
# the set-aside folder is named to the second
sleep 1
printf '%s' "signed by B" >"$ST/vol/demos_node_state/.demos_identity.signed.json"
printf '%s\n' "$KEY_C" >"$W/.demos_identity"
docker_run up -d
move_aside
expect "set aside, second swap: the printed command succeeds" test "$RC" -eq 0
expect "set aside, second swap: the first identity set aside is kept" aside 1 .demos_identity "$KEY_A"
expect "set aside, second swap: the first signing state set aside is kept" aside 1 .demos_identity.signed.json "signed by A"
expect "set aside, second swap: the identity is set aside" aside 2 .demos_identity "$KEY_B"
expect "set aside, second swap: its signing state goes with it" aside 2 .demos_identity.signed.json "signed by B"

new_world
seed_volume demos_node_state "$KEY_A"
printf '%s\n' "$KEY_B" >"$W/.demos_identity"
docker_run up -d
move_aside
expect "set aside, no signing state: the printed command succeeds" test "$RC" -eq 0
expect "set aside, no signing state: the identity is set aside" aside 1 .demos_identity "$KEY_A"
docker_run up -d
expect "set aside, no signing state: up then starts" started

# a move that fails part way (power loss, a full disk) leaves the identity
# with the signing state, so the next `up` still refuses the host identity
new_world
seed_volume demos_node_state "$KEY_A"
printf '%s' "signed by A" >"$ST/vol/demos_node_state/.demos_identity.signed.json"
printf '%s\n' "$KEY_B" >"$W/.demos_identity"
docker_run up -d
printf '#!/usr/bin/env bash\n[[ "$1" == *.demos_identity.signed.json ]] && { echo "mv: interrupted" >&2; exit 1; }\nexec %q "$@"\n' \
    "$(command -v mv)" >"$W/bin/mv"
chmod +x "$W/bin/mv"
move_aside
rm -f "$W/bin/mv"
expect "set aside, interrupted: the printed command fails" test "$RC" -ne 0
expect "set aside, interrupted: the identity stays in the volume" unchanged demos_node_state
docker_run up -d
expect "set aside, interrupted: up still refuses" test "$RC" -eq 1
expect "set aside, interrupted: compose up never runs" not_started
expect "set aside, interrupted: the volume copy is left as it was" unchanged demos_node_state

new_world
seed_volume demos_node_state "$KEY_A"
docker_run up -d
expect "no host identity: starts" test "$RC" -eq 0
expect "no host identity: the volume copy is left as it was" unchanged demos_node_state

new_world
mkdir -p "$ST/vol/demos_node_state"
printf '%s' "$KEY_B" >"$ST/vol/demos_node_state/.demos_identity"
seed_volume demos_node_state_53650 "$KEY_A"
printf '%s\n' "$KEY_B" >"$W/.demos_identity"
docker_run --port 53650 up -d
expect "--port instance: compares its own volume and refuses" test "$RC" -ne 0
expect "--port instance: its volume copy is left as it was" unchanged demos_node_state_53650
expect "--port instance: names its volume" says "demos_node_state_53650"

new_world
printf '%s\n' "$KEY_A" >"$W/.demos_identity"
export STUB_FAIL_RUN=1
docker_run up -d
unset STUB_FAIL_RUN
expect "sync container fails: refuses" test "$RC" -ne 0
expect "sync container fails: compose up never runs" not_started

new_world
seed_volume demos_node_state "$KEY_A"
printf '%s\n' "$KEY_B" >"$W/.demos_identity"
docker_run down
expect "down: runs whatever the identities" test "$RC" -eq 0
expect "down: the volume copy is left as it was" unchanged demos_node_state

echo "# $PASS passed, $FAIL failed"
exit "$FAIL"
