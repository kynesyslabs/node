#!/usr/bin/env bash
# Tests of run.sh and gen-compose.py against a fake docker (test/fake-bin/docker,
# state in a temp dir). Nothing here touches a real Docker daemon, and what it
# proves stops at the script's own logic: that the probes, volumes, ownership and
# images behave as in the fake is for a real run to show.
#
#   testing/devnet/backup-restore-drill/test/run-fake-tests.sh [case-name-prefix]
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRILL="$(cd "${HERE}/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/bkdrill-fake.XXXXXX")"
PASS=0
FAIL=0
ONLY="${1:-}"

# The environment every case starts from: a quiet host, small thresholds, no real bun
base_env() {
    export PATH="${HERE}/fake-bin:${PATH}"
    export IDENTITY_GEN=host LOAD_MAX=100000 NODE_EST_MB=1 HEADROOM_MB=1 MIN_DISK_GB=1
    export BASE_PORT=65100 PROJECT=demos-faketest SERVE_TIMEOUT=30 BRINGUP_TIMEOUT=60 REJOIN_TIMEOUT=60 SIGN_TIMEOUT=60
}

# go NAME [VAR=value ...]: run.sh with that environment; output in $WORK/NAME.out, exit code in RC
go() {
    local name="$1"
    shift
    CASE="${name}"
    CDIR="${WORK}/${name}"
    mkdir -p "${CDIR}/runs"
    : > "${CDIR}/calls.log"
    (
        base_env
        export FAKE_DIR="${CDIR}" RUNS_DIR="${CDIR}/runs" LOCK_DIR="${CDIR}"
        for kv in "$@"; do export "${kv?}"; done
        timeout 300 "${DRILL}/run.sh" > "${CDIR}/out.txt" 2>&1 < /dev/null
    )
    RC=$?
}
ok() { PASS=$((PASS + 1)); echo "ok   - ${CASE}: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL - ${CASE}: $1"; sed -n '1,400p' "${CDIR}/out.txt" | tail -n 25 | sed 's/^/        | /'; }
want_rc() { if [ "${RC}" = "$1" ]; then ok "exit code $1"; else bad "exit code ${RC}, wanted $1"; fi; }
want_out() { if grep -qE -- "$1" "${CDIR}/out.txt"; then ok "output has: $2"; else bad "output lacks: $2 (/$1/)"; fi; }
no_out() { if grep -qE -- "$1" "${CDIR}/out.txt"; then bad "output has: $2 (/$1/)"; else ok "output has no: $2"; fi; }
no_call() { if grep -qE -- "$1" "${CDIR}/calls.log"; then bad "docker was called with: $2"; else ok "docker never called with: $2"; fi; }
want_call() { if grep -qE -- "$1" "${CDIR}/calls.log"; then ok "docker called with: $2"; else bad "docker not called with: $2"; fi; }
torn_down() {
    if [ "$(jq '[.containers | length, (.volumes | length)] | add' "${CDIR}/state.json")" = 0 ]; then ok "teardown left no container or volume"; else bad "containers or volumes left in the fake"; fi
}
sel() { [ -z "${ONLY}" ] || [[ "$1" == "${ONLY}"* ]]; }
one_fail() { # $1 regex of the check that must be the run's only failed one
    local n
    n="$(grep -c 'CHECK FAIL' "${CDIR}/out.txt")"
    if [ "${n}" = 1 ] && grep -qE -- "CHECK FAIL: $1" "${CDIR}/out.txt"; then ok "the only failed check: $1"; else bad "${n} failed checks, wanted only /$1/"; fi
}
no_all_row() { if grep -q '^ALL' "${CDIR}"/runs/*/phases.tsv; then bad "an ALL row (stopped until rejoined and signing)"; else ok "no ALL row"; fi; }

# ── gen-compose.py: the gossip default, on its own ──────────────────────
gen() { # GOSSIP value or "unset" -> the value in the compose file, or the error
    local d="${WORK}/gen-$1"
    mkdir -p "${d}/inputs"
    if [ "$1" = unset ]; then
        env -u GOSSIP_ENABLED python3 -I "${DRILL}/gen-compose.py" --run-dir "${d}" --nodes 4 --image i --pg-image p --node-mem 1g --pg-mem 1g \
            --consensus-time 10 --base-port 65100 --cpu-shares 256 --x-node 4 --migrate-cmd true > "${d}/out.txt" 2>&1
    else
        GOSSIP_ENABLED="$1" python3 -I "${DRILL}/gen-compose.py" --run-dir "${d}" --nodes 4 --image i --pg-image p --node-mem 1g --pg-mem 1g \
            --consensus-time 10 --base-port 65100 --cpu-shares 256 --x-node 4 --migrate-cmd true > "${d}/out.txt" 2>&1
    fi
    GRC=$?
    GVAL="$(jq -r '[.services | to_entries[] | select(.key | startswith("node-")) | .value.environment.GOSSIP_ENABLED] | unique | join(",")' "${d}/compose.yml" 2> /dev/null || true)"
}
if sel gen; then
    CASE=gen-compose
    CDIR="${WORK}/gen-unset"
    gen unset
    if [ "${GRC}" = 0 ] && [ "${GVAL}" = true ]; then ok "GOSSIP_ENABLED unset gives true on every node (incl. node-iso)"; else bad "unset gave rc ${GRC} value '${GVAL}'"; fi
    gen true
    if [ "${GVAL}" = true ]; then ok "GOSSIP_ENABLED=true gives true"; else bad "true gave '${GVAL}'"; fi
    gen false
    if [ "${GRC}" = 0 ] && [ "${GVAL}" = false ]; then ok "explicit GOSSIP_ENABLED=false gives false"; else bad "false gave rc ${GRC} value '${GVAL}'"; fi
    gen maybe
    CDIR="${WORK}/gen-maybe"
    if [ "${GRC}" != 0 ] && grep -q 'must be true or false' "${CDIR}/out.txt"; then ok "GOSSIP_ENABLED=maybe is refused"; else bad "maybe: rc ${GRC}"; fi
fi

# ── SMOKE=1 ─────────────────────────────────────────────────────────────
if sel smoke-pass; then
    go smoke-pass SMOKE=1
    want_rc 0
    want_out 'SMOKE PASS' "SMOKE PASS"
    want_out 'CHECK PASS: gossip enabled on every node' "gossip check"
    want_out 'CHECK PASS: node state is writable by uid 1000' "writability check"
    want_out 'CHECK PASS: smoke: node 4 serves RPC at head >= 2' "node 4 line"
    want_out 'PHASE S smoke: up to every node serving at head >= 2: ' "the phase row says every node got there"
    want_call 'up --no-start' "up --no-start (volumes created by compose)"
    no_call 'compose.* run --rm --no-deps -T -e PG_HOST=pg-iso' "the isolated node's migration"
    no_out 'PHASE A ' "any drill phase (backup)"
    torn_down
    want_out 'left over in demos-faketest after teardown: 0 containers, 0 volumes, 0 networks' "teardown's leftover counts"
    if [ "$(cat "${CDIR}/lock-at-down" 2> /dev/null)" = held ]; then ok "the project lock is still held at compose down"; else bad "the project lock was not held at compose down"; fi
    if jq -e '.cleanup == "done, nothing of demos-faketest left"' "${CDIR}"/runs/*/timings.json > /dev/null \
        && grep -q '^- cleanup: done, nothing of demos-faketest left$' "${CDIR}"/runs/*/timings.md; then
        ok "cleanup done in timings.json and timings.md"
    else bad "timings.json/md do not say the cleanup was done"; fi
    no_call ' up .*node-iso' "up of node-iso (smoke is the 4 validators only)"
    # the node env really carries GOSSIP_ENABLED=true (the default, nothing set by the caller)
    if jq -e '[.services | to_entries[] | select(.key | startswith("node-")) | .value.environment.GOSSIP_ENABLED] | all(. == "true")' "${CDIR}"/runs/*/compose.yml > /dev/null; then
        ok "smoke compose file: GOSSIP_ENABLED true on every node (default)"
    else bad "smoke compose file has gossip not true"; fi
    # FORK_SET unset: the real gen-inputs.py got --fork-set launch
    want_out 'fork_set=launch ' "the fork set at the start of the run"
    want_out 'forks \(launch\): .*unpinnedCommittee@0.*; excluded: identityCarryover' "the launch forks and the excluded one"
    if jq -e '.forks.unpinnedCommittee.activationHeight == 0' "${CDIR}"/runs/*/inputs/genesis.json > /dev/null \
        && grep -q 'launch fork set (docs/mainnet/genesis.template.json)' "${CDIR}"/runs/*/logs/02-inputs.log; then
        ok "default FORK_SET: gen-inputs.py wrote the launch fork set"
    else bad "default FORK_SET did not give the launch fork set"; fi
    if jq -e '.forkSet == "launch"' "${CDIR}"/runs/*/timings.json > /dev/null && grep -q 'fork set `launch`' "${CDIR}"/runs/*/timings.md; then
        ok "fork set in timings.json and timings.md"
    else bad "fork set missing from the summary"; fi
fi
if sel fork-set-devnet; then
    go fork-set-devnet SMOKE=1 FORK_SET=devnet
    want_rc 0
    want_out 'fork_set=devnet ' "the fork set at the start of the run"
    want_out 'forks \(devnet\): .*quorumParity@0' "the devnet forks"
    if jq -e '(.forks | has("unpinnedCommittee") | not) and .forks.committeeBinding.activationHeight == 0' "${CDIR}"/runs/*/inputs/genesis.json > /dev/null \
        && ! grep -q 'launch fork set' "${CDIR}"/runs/*/logs/02-inputs.log && [ -z "$(find "${CDIR}/runs" -name launch-excluded.json)" ]; then
        ok "FORK_SET=devnet reaches gen-inputs.py: genesis.devnet.json's forks, no launch set"
    else bad "FORK_SET=devnet did not reach gen-inputs.py"; fi
    if jq -e '.forkSet == "devnet"' "${CDIR}"/runs/*/timings.json > /dev/null; then ok "fork set devnet in timings.json"; else bad "timings.json fork set is not devnet"; fi
fi
if sel fork-set-invalid; then
    go fork-set-invalid SMOKE=1 FORK_SET=mainnet
    want_rc 2
    want_out "FORK_SET must be launch or devnet, got 'mainnet'" "config error"
    no_call 'compose' "compose (nothing ran)"
fi
if sel smoke-behind; then
    go smoke-behind SMOKE=1 SMOKE_TIMEOUT=8 FAKE_BEHIND=node-2
    want_rc 1
    want_out 'SMOKE FAIL' "SMOKE FAIL"
    want_out 'CHECK FAIL: smoke: node 2 .*serves RPC but head 0 < 2.*node-2.log' "node 2 failure with its log hint"
    want_out 'CHECK PASS: smoke: node 1 ' "node 1 still reported PASS"
    no_out 'PHASE S smoke: up to every node serving' "a phase row saying every node got there"
    torn_down
fi
if sel smoke-noserve; then
    go smoke-noserve SMOKE=1 SMOKE_TIMEOUT=8 FAKE_NEVER_SERVE=node-3
    want_rc 1
    want_out 'CHECK FAIL: smoke: node 3 .*does not serve RPC' "node 3 does not serve"
    want_out 'last lines of node-3' "log tail of the failing node"
    torn_down
fi
if sel smoke-noimage; then
    go smoke-noimage SMOKE=1 FAKE_MISSING_IMAGES=postgres:16-alpine
    want_rc 2
    want_out 'not present locally' "missing image message"
    no_call 'up' "up (nothing started)"
fi

# ── gossip ──────────────────────────────────────────────────────────────
if sel gossip-off-refused; then
    go gossip-off-refused SMOKE=1 GOSSIP_ENABLED=false
    want_rc 2
    want_out 'gossip is not enabled on every node \(node-1=false' "refusal naming the nodes"
    want_out "already synced" "the reason (already synced while behind)"
    no_call ' up ' "up (no node started, no volume created)"
fi
if sel gossip-off-refused-full; then
    go gossip-off-refused-full GOSSIP_ENABLED=false
    want_rc 2
    want_out 'ALLOW_GOSSIP_OFF=1' "the way out"
    no_call ' up ' "up (timed phases never started)"
fi
if sel gossip-off-allowed; then
    go gossip-off-allowed SMOKE=1 GOSSIP_ENABLED=false ALLOW_GOSSIP_OFF=1
    want_rc 0
    want_out 'WARNING: gossip is not enabled' "warning"
    want_out 'CHECK INFO: gossip enabled on every node \(OFF on purpose' "recorded as INFO"
    if jq -e '[.services | to_entries[] | select(.key | startswith("node-")) | .value.environment.GOSSIP_ENABLED] | all(. == "false")' "${CDIR}"/runs/*/compose.yml > /dev/null; then
        ok "explicit override reaches the compose file"
    else bad "override not in the compose file"; fi
fi
if sel gossip-invalid; then
    go gossip-invalid SMOKE=1 GOSSIP_ENABLED=maybe
    want_rc 2
    want_out 'GOSSIP_ENABLED must be true or false' "config error"
fi
if sel gossip-nonode; then
    go gossip-nonode SMOKE=1 FAKE_NO_NODE=1
    want_rc 2
    want_out 'has no .node. on the PATH' "no Node in the image"
fi

# ── writability ─────────────────────────────────────────────────────────
if sel unwritable-smoke; then
    go unwritable-smoke SMOKE=1 FAKE_ROOT_VOLS=state-3
    want_rc 2
    want_out 'cannot write to: volume demos-faketest_state-3 at /app/state \(node-3\)' "message names the volume, path and node"
    want_out 'Nothing was changed' "no silent chown"
    want_out 'FIX_OWNERSHIP=1' "the opt-in is named"
    no_call ' up -d' "up -d (no node or postgres started)"
    no_call 'chown' "chown"
    want_call 'up --no-start' "up --no-start (only creates)"
    torn_down
fi
if sel unwritable-full; then
    go unwritable-full FAKE_ROOT_VOLS=state-1,state-4
    want_rc 2
    want_out 'state-1 at /app/state \(node-1\); .*state-4 at /app/state \(node-4\)' "all unwritable volumes listed"
    no_call ' up -d' "up -d"
    no_out 'PHASE ' "any phase"
    torn_down
fi
if sel unwritable-image-dir; then
    go unwritable-image-dir SMOKE=1 FAKE_UNWRITABLE_PATHS=/app/logs
    want_rc 2
    want_out '/app/logs in the image' "the image's own log dir is checked"
    no_call ' up -d' "up -d"
fi
if sel unwritable-tmpfs; then
    go unwritable-tmpfs SMOKE=1 FAKE_ADD_TMPFS=/app/scratch
    want_rc 2
    want_out 'tmpfs /app/scratch \(node-1\)' "root-owned tmpfs is refused"
    go writable-tmpfs SMOKE=1 FAKE_ADD_TMPFS=/app/scratch:uid=1000
    want_rc 0
    want_out 'uid 1000 can write: tmpfs /app/scratch:uid=1000' "tmpfs with uid=1000 passes"
fi
if sel fix-ownership; then
    go fix-ownership SMOKE=1 FAKE_ROOT_VOLS=state-3 FIX_OWNERSHIP=1
    want_rc 0
    want_out 'FIX_OWNERSHIP=1: chown -R 1000:1000 on volume demos-faketest_state-3' "the chown is announced and names the volume"
    want_out 'uid 1000 can write after the chown: volume demos-faketest_state-3' "re-probed after the chown"
    if [ "$(grep -c 'chown' "${CDIR}/calls.log")" = 1 ]; then ok "exactly one chown, on the one bad volume"; else bad "chown count $(grep -c chown "${CDIR}/calls.log")"; fi
    if grep chown "${CDIR}/calls.log" | grep -q 'demos-faketest_state-3:/x'; then ok "chown limited to this project's volume"; else bad "chown on a foreign volume"; fi
    torn_down
fi

# ── the full drill, regression of the wipe and everything around it ──────
if sel full-rejoin; then
    go full-rejoin
    want_rc 0
    want_out 'CHECK PASS: the wipe kept the ownership of the state volume' "ownership preserved by the wipe"
    want_out 'CHECK PASS: node 4 signs after the restart' "node 4 signs"
    want_out 'CHECK PASS: restart signing floor logged before signing' "the floor line in node 4's log"
    want_out 'CHECK PASS: restored head >= pre-wipe head' "head after restore"
    want_out 'CHECK PASS: other nodes never stalled while node 4 was down' "the other nodes' head rose: stall check PASS"
    want_out 'CHECK PASS: node 4 within 2 blocks of the others at the end of D' "still within 2 blocks after D"
    if grep -q '^ALL' "${CDIR}"/runs/*/phases.tsv; then ok "an ALL row (rejoined and signing)"; else bad "no ALL row"; fi
    want_out 'RESULT PASS: rejoin drill' "result PASS"
    no_out 'CHECK FAIL' "any failed check"
    want_out 'left on the state volume: node.identity node.identity.commitlock.json node.identity.prevote.json node.identity.signed.json' "wipe kept only identity and signing state"
    want_out 'CHECK PASS: signing state unchanged or advanced, never older \(.*\.commitlock\.json=advanced .*\.prevote\.json=advanced .*\.signed\.json=advanced ' "every signing file advanced by (height, round)"
    # Call order of the restore: pg_restore, then the migration of node 4's database, then node 4's start
    read -r o_r o_m o_u <<< "$(awk '/pg_restore -U/ && !r { r = NR }
        r && !m && /run --rm --no-deps -T -e PG_HOST=pg-4 .*migrate/ { m = NR }
        r && !u && /up -d --no-deps --pull never node-4$/ { u = NR }
        END { print r + 0, m + 0, u + 0 }' "${CDIR}/calls.log")"
    if [ "${o_r}" -gt 0 ] && [ "${o_m}" -gt "${o_r}" ] && [ "${o_u}" -gt "${o_m}" ]; then
        ok "migrate runs after pg_restore and before node-4 starts (calls ${o_r} < ${o_m} < ${o_u})"
    else bad "restore call order pg_restore/migrate/node-4 start: ${o_r} ${o_m} ${o_u}"; fi
    no_call 'state-4:/s:ro -v [^ ]*backup-4:' "a helper with node 4's state volume and the backup volume (no state copy)"
    torn_down
fi
if sel full-isolated; then
    go full-isolated VARIANT=isolated
    want_rc 0
    want_out 'CHECK PASS: the validators kept forging during the drill' "the validators' head rose: stall check PASS"
    want_out "CHECK PASS: isolated node holds no copy of node 4's key" "node-iso holds no copy of the key"
    want_out 'CHECK PASS: node 4 untouched and the only holder of its key \(one node-4 container, the one started at bring-up, and the only container on its state volume\)' "node 4 the one holder"
    want_out 'RESULT PASS: isolated drill' "result PASS"
    no_out 'CHECK FAIL' "any failed check"
    torn_down
fi
if sel floor-log; then
    # the floor line early in node 4's log, then 5000 more lines (more than a pipe holds): a
    # reader that stops at the match kills docker logs with SIGPIPE, which must not read as absent
    go floor-log-long FAKE_LOG_FILL=5000
    want_rc 0
    want_out 'CHECK PASS: restart signing floor logged before signing' "the floor line found ahead of 5000 more lines"
    torn_down
    # the same long log without the line: INFO, saying the line is missing
    go floor-log-missing FAKE_LOG_FILL=5000 FAKE_NO_FLOOR_LOG=1
    want_rc 0
    want_out "CHECK INFO: restart signing floor logged before signing \(the \[SIGNING\] Restart signing floor line is missing from node 4's log\)" "INFO naming the missing line"
    no_out 'wording may differ' "the old 'wording may differ' detail"
    torn_down
fi
if sel dump-cut; then
    # a dump that ends after its table of contents: the whole-archive read fails in phase A, before any wipe
    go dump-cut FAKE_DUMP_CUT=1
    want_rc 2
    want_call 'pg_restore --file=/dev/null node4\.dump' "the whole-archive read of the dump"
    want_out 'the dump is empty or cannot be read to its end' "the failed read stops the run"
    no_out 'PHASE A ' "a phase A row"
    no_call 'stop -t [0-9]+ node-4$' "the stop of node-4 (the run stops in phase A)"
    no_call 'volume rm' "volume rm (no database wiped)"
    no_call 'find \. -mindepth 1' "the state wipe"
    no_call 'pg_restore -U' "pg_restore"
    torn_down
    # the copy on the host is not the dump that was hashed: the run stops in phase A2
    go dump-cp-corrupt FAKE_CP_CORRUPT=1
    want_rc 2
    want_out 'the copy on the host does not match its sha256' "the failed check stops the run"
    no_out 'PHASE A2 ' "a phase A2 row"
    no_call 'stop -t [0-9]+ node-4$' "the stop of node-4"
    torn_down
fi
if sel wipe-owner; then
    go wipe-owner FAKE_WIPE_CHANGES_OWNER=1
    want_rc 2
    want_out 'CHECK FAIL: the wipe kept the ownership of the state volume' "ownership change recorded"
    want_out 'after the wipe uid 1000 cannot write node 4' "fail fast before the restart"
    # node 4 was started once (bring-up) and never again after the wipe
    if [ "$(grep -cE 'up -d --no-deps --pull never node-4$' "${CDIR}/calls.log")" = 1 ]; then ok "node-4 never restarted after the failed probe"; else bad "node-4 start count is not 1"; fi
    go wipe-owner-fix FAKE_WIPE_CHANGES_OWNER=1 FIX_OWNERSHIP=1
    want_out "state volume was chowned back to 1000:1000" "opt-in fix after the wipe"
    want_out 'CHECK FAIL: the wipe kept the ownership' "the change is still reported"
    want_rc 1
fi
if sel wipe-leftover; then
    # an entry the wipe could not remove, the wipe itself exiting 0: the listing catches it
    go wipe-leftover FAKE_WIPE_LEAVE=extra.dat
    want_rc 2
    want_out "the wipe left more than node.identity\* on node 4's state volume: extra.dat$" "the leftover entry named"
    if [ "$(grep -cE 'up -d --no-deps --pull never node-4$' "${CDIR}/calls.log")" = 1 ]; then ok "node-4 never restarted after the leftover"; else bad "node-4 start count is not 1"; fi
    no_call 'pg_restore -U' "pg_restore (the run stops in phase B)"
    no_out 'PHASE B ' "a phase B row"
    torn_down
    # the same, the wipe exiting 1
    go wipe-fail FAKE_WIPE_LEAVE=extra.dat FAKE_WIPE_FAIL=1
    want_rc 2
    want_out 'could not clear the non-identity state' "the failed wipe stops the run"
    if [ "$(grep -cE 'up -d --no-deps --pull never node-4$' "${CDIR}/calls.log")" = 1 ]; then ok "node-4 never restarted after the failed wipe"; else bad "node-4 start count is not 1"; fi
    torn_down
fi
if sel wipe-drop; then
    # a wipe that also removes a signing state file: caught before node X starts again
    go wipe-drop FAKE_WIPE_DROP=node.identity.prevote.json
    want_rc 2
    want_out "the wipe changed or removed node 4's identity or signing state files: node.identity.prevote.json \(sums.stop, sums.wiped\)" "the removed file named"
    if [ "$(grep -cE 'up -d --no-deps --pull never node-4$' "${CDIR}/calls.log")" = 1 ]; then ok "node-4 never restarted after the changed signing state"; else bad "node-4 start count is not 1"; fi
    no_call 'pg_restore -U' "pg_restore (the run stops in phase B)"
    torn_down
fi

# ── signing state files older than at stop ──────────────────────────────
if sel signing-older; then
    # the commit lock one height below its at-stop value after the restart
    go signing-older-lock FAKE_OLDER_RECORD=commitlock:height
    want_rc 1
    want_out 'CHECK FAIL: signing state unchanged or advanced, never older \( node.identity.commitlock.json is older than at stop: [0-9]+/[0-9]+ -> [0-9]+/[0-9]+ \(height/round\)' "an older commit lock fails the check"
    no_out 'CHECK PASS: signing state' "a PASS of the signing state check"
    # the prevote record one round below its at-stop value, at the same height
    go signing-older-prevote FAKE_OLDER_RECORD=prevote:round
    want_rc 1
    want_out 'CHECK FAIL: signing state unchanged or advanced, never older \( node.identity.prevote.json is older than at stop: ' "an older prevote round fails the check"
    if grep -qE 'prevote.json is older than at stop: ([0-9]+)/[0-9]+ -> \1/[0-9]+ ' "${CDIR}/out.txt"; then ok "same height at stop and after, lower round"; else bad "the prevote case is not at the same height"; fi
    # the commit lock equal to its at-stop value: unchanged, not advanced, and no failure
    go signing-same-lock FAKE_OLDER_RECORD=commitlock:same
    want_rc 0
    want_out 'CHECK PASS: signing state unchanged or advanced, never older \(.*\.commitlock\.json=unchanged [0-9]+/[0-9]+ ' "an equal commit lock is unchanged"
    torn_down
fi

# ── the manual migration of the restored database ───────────────────────
node4_starts() { grep -cE 'up -d --no-deps --pull never node-4$' "${CDIR}/calls.log"; }
if sel migrate-fail; then
    go migrate-fail FAKE_MIGRATE_FAIL=1
    want_rc 2
    want_out "WARNING: migrations on node 4's database failed" "bring-up only warns"
    want_out 'migrations failed on the restored database' "the restore stops on it"
    if [ "$(node4_starts)" = 1 ]; then ok "node-4 not started after the failed migration"; else bad "node-4 start count $(node4_starts), wanted 1 (bring-up only)"; fi
    no_out 'PHASE C ' "a phase C row"
    torn_down
    go migrate-fail-isolated VARIANT=isolated FAKE_MIGRATE_FAIL=1
    want_rc 2
    want_out 'migrations failed on the isolated database' "the isolated restore stops on it"
    no_out 'PHASE IC ' "a phase IC row"
    no_call 'up -d --no-deps --pull never node-iso' "the start of node-iso"
    torn_down
fi
if sel migrate-timeout; then
    go migrate-timeout FAKE_MIGRATE_HANG=pg-4 MIGRATE_TIMEOUT=2
    want_rc 2
    want_out 'migrations on node4_db timed out after 2s and were stopped' "the timeout is named"
    no_out 'migrations on node1_db timed out' "a timeout on a database that did not hang"
    want_out 'migrations failed on the restored database' "the restore stops on it"
    if [ "$(node4_starts)" = 1 ]; then ok "node-4 not started after the timed-out migration"; else bad "node-4 start count $(node4_starts), wanted 1 (bring-up only)"; fi
    torn_down
    # compose ignores the TERM: killed 10 s later (exit 137), still reported as a timeout
    go migrate-timeout-kill FAKE_MIGRATE_HANG=pg-4 FAKE_MIGRATE_IGNORE_TERM=1 MIGRATE_TIMEOUT=2
    want_rc 2
    want_out 'migrations on node4_db timed out after 2s and were stopped' "the timeout is named after the kill"
    if [ "$(node4_starts)" = 1 ]; then ok "node-4 not started after the killed migration"; else bad "node-4 start count $(node4_starts), wanted 1 (bring-up only)"; fi
    torn_down
    go migrate-timeout-invalid SMOKE=1 MIGRATE_TIMEOUT=0
    want_rc 2
    want_out 'MIGRATE_TIMEOUT must be at least 1' "timeout 0 (no limit) refused"
fi

# ── what the rejoin checks refuse: one fault each, the full drill otherwise ──
if sel rejoin-never; then
    # node 4 starts again at head 0 and never comes within 2 blocks
    go rejoin-never FAKE_REJOIN_LAG=100000 REJOIN_TIMEOUT=5
    want_rc 1
    want_out 'CHECK FAIL: node 4 rejoins \(head within 2 blocks\) \(head 0 vs others [0-9]+ after 5s\)' "the rejoin fails"
    want_out 'CHECK FAIL: restored head >= pre-wipe head \(head 0 < [0-9]+\)' "the restored head fails"
    no_out 'CHECK PASS: (restored head|node 4 (rejoins|signs|within))' "a PASS of the head, rejoin or signing checks"
    no_out 'PHASE D1? ' "a D1 or D phase row"
    no_all_row
    torn_down
fi
if sel rejoin-falls-behind; then
    # node 4 comes within 2 blocks and signs (phase D), then falls 9 blocks behind before the checks
    go rejoin-falls-behind FAKE_REJOIN_LAG=9:signed FAKE_SLOW_RESTORE=6
    want_rc 1
    want_out 'PHASE D rejoin: head within 2 blocks and node signing' "phase D reached"
    want_out 'CHECK FAIL: node 4 within 2 blocks of the others at the end of D \(head [0-9]+ vs others [0-9]+: ' "behind at the end of D: FAIL"
    no_out 'RESULT PASS' "RESULT PASS"
    one_fail 'node 4 within 2 blocks of the others at the end of D'
    torn_down
fi
if sel rejoin-nosign; then
    # node 4 rejoins, but its signing record stays at its at-stop value and no block carries its signature
    go rejoin-nosign FAKE_OLDER_RECORD=signed:same SIGN_TIMEOUT=5
    want_rc 1
    want_out 'CHECK FAIL: node 4 signs after the restart \(no signing within 5s of syncing\)' "no signing: FAIL"
    no_out 'CHECK PASS: node 4 signs' "a PASS of the signing check"
    no_out 'PHASE D ' "a D phase row"
    no_all_row
    one_fail 'node 4 signs after the restart'
    torn_down
fi
if sel rejoin-identity; then
    # node 4's identity file after the restart is not the one it stopped with
    go rejoin-identity FAKE_IDENTITY_CHANGED=1
    want_rc 1
    want_out 'CHECK FAIL: identity file checksum identical \(step 2, at stop, after rejoin\) \(step2=([0-9a-f]{12}) stop=\1 end=[0-9a-f]{12}\)' "a changed identity file: FAIL"
    one_fail 'identity file checksum identical'
    torn_down
fi
if sel rejoin-counts; then
    # the restored database holds no transactions
    go rejoin-counts FAKE_RESTORE_SHORT=transactions
    want_rc 1
    want_out 'CHECK FAIL: restore: restored counts match the dump \( transactions=0 not in \[[0-9]+,[0-9]+\]' "a row count outside the dump's window: FAIL"
    one_fail 'restore: restored counts match the dump'
    torn_down
fi
if sel rejoin-hash; then
    # node 2 has other blocks at the pre-wipe heights
    go rejoin-hash FAKE_OTHER_HASH=node-2
    want_rc 1
    want_out "CHECK FAIL: block hash at pre-wipe heights equals the other nodes' \( node2@[0-9]+=other[0-9]+!=hash[0-9]+" "another node's hash differs: FAIL"
    one_fail 'block hash at pre-wipe heights'
    torn_down
fi
if sel rejoin-schema; then
    # 4 migration files in the image, 3 rows in the restored database's migrations table
    go rejoin-schema FAKE_MIGRATION_FILES=4
    want_rc 1
    want_out "CHECK FAIL: schema at the image's head after the manual migration \(migrations table 3 rows vs 4 files in the image \(migrated=1\)\)" "migrations short of the image's head: FAIL"
    one_fail "schema at the image's head"
    torn_down
fi
if sel rejoin-halt; then
    go rejoin-halt FAKE_HALT_MARKER=1
    want_rc 1
    want_out 'CHECK FAIL: no halt marker, no foreign-signature log \(a .halted marker is on the state volume\)' "a halt marker: FAIL"
    one_fail 'no halt marker'
    torn_down
    go rejoin-foreign FAKE_FOREIGN_LOG=1
    want_rc 1
    want_out 'CHECK FAIL: no halt marker, no foreign-signature log \(1 foreign-signature lines after the restart\)' "a foreign-signature line: FAIL"
    one_fail 'no halt marker'
    torn_down
    # docker logs cannot read node 4's log (a logging driver without reads): no line can be ruled out
    go rejoin-log-unreadable FAKE_LOGS_FAIL=1
    want_rc 1
    want_out "CHECK FAIL: no halt marker, no foreign-signature log \(docker logs cannot read node 4's log" "an unreadable log: FAIL"
    no_out 'CHECK PASS: no halt marker' "a PASS of the halt and foreign-signature check"
    one_fail 'no halt marker'
    torn_down
fi
if sel rejoin-holder; then
    # from the backup on, a container that is not node 4 holds node 4's state volume
    go rejoin-holder FAKE_EXTRA_HOLDER=state-4
    want_rc 2
    want_out 'a container still holds the state volume of node 4' "the run stops before node 4 starts again"
    if [ "$(node4_starts)" = 1 ]; then ok "node-4 not started again"; else bad "node-4 start count $(node4_starts), wanted 1 (bring-up only)"; fi
    no_out 'CHECK PASS: one instance of the key at a time' "a PASS of the one-instance check"
    torn_down
fi

# ── what the isolated variant's checks refuse ───────────────────────────
if sel iso-counts; then
    # the restored database has no blocks: the counts and the head both fail
    go iso-counts VARIANT=isolated FAKE_RESTORE_SHORT=max_block
    want_rc 1
    want_out 'CHECK FAIL: isolated restore: restored counts match the dump \( max_block=0 not in \[[0-9]+,[0-9]+\]' "a head outside the dump's window: FAIL"
    want_out "CHECK FAIL: isolated DB reaches the dump's head \(max block 0 < [0-9]+\)" "the DB head below the dump's: FAIL"
    no_out "CHECK PASS: isolated (restore: restored counts|DB reaches)" "a PASS of either"
    torn_down
fi
if sel iso-hash; then
    # node 1, the network's source for the hash, has another block at the DB's head
    go iso-hash VARIANT=isolated FAKE_OTHER_HASH=node-1
    want_rc 1
    want_out "CHECK FAIL: isolated DB's head block hash equals the network's \(db hash[0-9]+ net other[0-9]+\)" "another hash: FAIL"
    one_fail "isolated DB's head block hash"
    torn_down
fi
if sel iso-schema; then
    go iso-schema VARIANT=isolated FAKE_MIGRATION_FILES=4
    want_rc 1
    want_out "CHECK FAIL: schema at the image's head after the manual migration \(migrations table 3 rows vs 4 files \(migrated=1\)\)" "migrations short of the image's head: FAIL"
    one_fail "schema at the image's head"
    torn_down
fi
if sel iso-behind; then
    # node-iso serves but stays at head 0
    go iso-behind VARIANT=isolated FAKE_BEHIND=node-iso REJOIN_TIMEOUT=5
    want_rc 1
    want_out 'CHECK FAIL: isolated node reaches the expected head \(head 0 vs DB head [0-9]+, network [0-9]+ after 5s\)' "node-iso behind: FAIL"
    no_out 'PHASE ID ' "a phase ID row"
    one_fail 'isolated node reaches the expected head'
    torn_down
fi
if sel iso-key; then
    # node-iso's state volume holds a copy of node 4's identity file
    go iso-key VARIANT=isolated FAKE_ISO_KEY_OF=state-4
    want_rc 1
    want_out "CHECK FAIL: isolated node holds no copy of node 4's key \(same identity file hash\)" "a copy of the key: FAIL"
    one_fail 'isolated node holds no copy'
    torn_down
    # node-iso's state volume cannot be read: its identity is not known to differ
    go iso-key-unreadable VARIANT=isolated FAKE_ISO_UNREADABLE=1
    want_rc 1
    want_out "CHECK FAIL: isolated node holds no copy of node 4's key \(cannot read node-iso's identity file" "an unreadable identity: FAIL"
    no_out 'CHECK PASS: isolated node holds no copy' "a PASS of the key check"
    one_fail 'isolated node holds no copy'
    torn_down
fi
if sel iso-holder; then
    # from the backup on, a container that is not node 4 holds node 4's state volume
    go iso-holder VARIANT=isolated FAKE_EXTRA_HOLDER=state-4
    want_rc 1
    want_out 'CHECK FAIL: node 4 untouched and the only holder of its key \(' "a second holder of the state volume: FAIL"
    no_out 'CHECK PASS: node 4 untouched' "a PASS of the holder check"
    one_fail 'node 4 untouched and the only holder of its key'
    torn_down
fi

# ── volumes that exist before the run ───────────────────────────────────
seed_vols() { # case name, volume names: volumes without the compose labels, there before the run
    local d="${WORK}/$1"
    shift
    mkdir -p "${d}"
    printf '%s\n' "$@" | jq -Rn '{containers: {}, t0: null, volumes: ([inputs | {key: ., value: {owner: "1000", project: "",
        files: ["keep.me"], db: "empty", frozen: false, frozen_head: 0, dump_head: 0}}] | from_entries)}' > "${d}/state.json"
}
still_there() { if jq -e --arg v "$1" '.volumes[$v].files == ["keep.me"]' "${CDIR}/state.json" > /dev/null; then ok "$1 still there, untouched"; else bad "$1 gone or changed"; fi; }
if sel existing-volume; then
    seed_vols existing-volume demos-faketest_state-4
    go existing-volume
    want_rc 2
    want_out 'already exist: demos-faketest_state-4\. ' "the existing volume named"
    no_call 'compose .* up ' "compose up"
    no_call 'compose .* down' "compose down"
    still_there demos-faketest_state-4
    if jq -e '.cleanup == "not needed, the compose project was never created"' "${CDIR}"/runs/*/timings.json > /dev/null; then
        ok "timings.json: no cleanup needed"
    else bad "timings.json cleanup is not 'not needed'"; fi
    # every name found is listed; the isolated node's volumes are declared in every variant
    seed_vols existing-volumes-iso demos-faketest_pgdata-1 demos-faketest_backup-4 demos-faketest_state-iso
    go existing-volumes-iso
    want_rc 2
    for v in pgdata-1 backup-4 state-iso; do want_out "already exist: [^.]*demos-faketest_${v}[ .]" "${v} named"; done
    no_call 'compose .* (up|down) ' "compose up or down"
    # exact names only: a volume whose name merely starts like one is not refused
    seed_vols existing-volume-other demos-faketest_state-44
    go existing-volume-other SMOKE=1
    want_rc 0
    still_there demos-faketest_state-44
fi

# ── teardown that fails or leaves something ─────────────────────────────
if sel teardown-fail; then
    go teardown-fail SMOKE=1 FAKE_DOWN_FAIL=1
    want_out 'SMOKE PASS' "the smoke check itself passed"
    want_rc 3
    want_out 'CLEANUP FAILED: compose down -v exited 1 \(logs/teardown.log\); left over: [1-9][0-9]* containers, [1-9][0-9]* volumes' "the failure and what is left"
    want_out 'check and remove by hand: docker ps -a, docker volume ls and docker network ls' "what to check"
    if jq -e '.result == "PASS" and (.cleanup | startswith("FAILED: compose down -v exited 1"))' "${CDIR}"/runs/*/timings.json > /dev/null \
        && grep -q '^- cleanup: \*\*FAILED\*\*: compose down -v exited 1' "${CDIR}"/runs/*/timings.md; then
        ok "timings.json and timings.md mark the cleanup failure"
    else bad "the cleanup failure is not in timings.json/md"; fi
    # down exits 0 but a volume is left
    go teardown-leave SMOKE=1 FAKE_DOWN_LEAVE=state-2
    want_rc 3
    want_out 'CLEANUP FAILED: left over: 0 containers, 1 volumes, 0 networks$' "the leftover volume counted"
    # a failed run keeps its exit code; the cleanup failure is still marked
    go teardown-fail-after-fail SMOKE=1 SMOKE_TIMEOUT=8 FAKE_BEHIND=node-2 FAKE_DOWN_FAIL=1
    want_rc 1
    if jq -e '.result == "FAIL" and (.cleanup | startswith("FAILED"))' "${CDIR}"/runs/*/timings.json > /dev/null; then
        ok "FAIL result with the cleanup failure marked"
    else bad "timings.json: result/cleanup not FAIL/FAILED"; fi
    # the full drill: every check passes, the teardown fails, the exit is 3, not 0
    go teardown-fail-full FAKE_DOWN_FAIL=1
    want_out 'RESULT PASS: rejoin drill' "the drill's own checks passed"
    want_rc 3
    want_out 'CLEANUP FAILED: compose down -v exited 1' "the cleanup failure"
    if jq -e '.result == "PASS" and (.cleanup | startswith("FAILED: compose down -v exited 1"))' "${CDIR}"/runs/*/timings.json > /dev/null; then
        ok "timings.json marks the cleanup failure"
    else bad "the cleanup failure is not in timings.json"; fi
fi

# ── the stall checks when head reads fail ───────────────────────────────
stall_of() { # monitor file, from, to: run.sh's own monitor_stats and stall_verdict (run.sh cannot be sourced: it runs the drill)
    (
        # shellcheck disable=SC1090
        source <(sed -n '/^monitor_stats() {/,/^}/p; /^stall_verdict() {/,/^}/p' "${DRILL}/run.sh")
        MON_FILE="$1" STALL_LIMIT=90
        stall_verdict "$2" "$3"
        echo "${STALL_RESULT}: ${STALL_DETAIL}"
    ) > "${CDIR}/out.txt" 2>&1
}
if sel monitor-stats; then
    CASE=monitor-stats
    CDIR="${WORK}/monitor-stats"
    mkdir -p "${CDIR}"
    # head 10 read at 0 s, every read from 5 to 115 s failed, head 11 read at 120 s; STALL_LIMIT 90
    { printf '0\t10\n'; for t in $(seq 5 5 115); do printf '%s\t\n' "${t}"; done; printf '120\t11\n'; } > "${CDIR}/blind.tsv"
    stall_of "${CDIR}/blind.tsv" 0 120
    want_out '^FAIL: no head read for 120s, more than 90s: a stall in that time cannot be ruled out; longest gap 120s' "heads at 0 and 120 s, failed reads between: FAIL with the reason"
    no_out '^PASS' "PASS"
    # a read every 5 s, the head rising every 10 s
    for t in $(seq 0 5 120); do printf '%s\t%s\n' "${t}" $((t / 10)); done > "${CDIR}/steady.tsv"
    stall_of "${CDIR}/steady.tsv" 0 120
    want_out '^PASS: longest gap 10s, longest without a head read 5s ' "steady reads and rises: PASS"
    # five reads of head 5 over 20 s, well within STALL_LIMIT: no new block, so FAIL
    for t in 0 5 10 15 20; do printf '%s\t5\n' "${t}"; done > "${CDIR}/flat.tsv"
    stall_of "${CDIR}/flat.tsv" 0 20
    want_out '^FAIL: no new block on the watched validators between 0 and 20 .*head 5 -> 5, 5 samples, 0 unreadable' "five reads of one head: FAIL with the reason"
    no_out '^PASS' "PASS"
    # the same five reads, the head rising from 5 to 7
    for t in 0 5 10 15 20; do printf '%s\t%s\n' "${t}" $((5 + t / 10)); done > "${CDIR}/rising.tsv"
    stall_of "${CDIR}/rising.tsv" 0 20
    want_out '^PASS: longest gap 10s, .*head 5 -> 7, 5 samples' "five reads, the head rising: PASS"
    # a read every 15 s, every read between failed: 8 of 13 reads failed, no hole above the limit
    for t in $(seq 0 5 60); do if [ $((t % 15)) = 0 ]; then printf '%s\t%s\n' "${t}" $((10 + t / 15)); else printf '%s\t\n' "${t}"; fi; done > "${CDIR}/sparse.tsv"
    stall_of "${CDIR}/sparse.tsv" 0 60
    want_out '^FAIL: longest gap 15s, longest without a head read 15s \(limit 90s\), head 10 -> 14, 5 samples, 8 unreadable' "more than half the reads failed: FAIL"
    no_out '^PASS' "PASS"
    # as the run writes them: the lowest and the highest head of the watched nodes. The
    # lowest rises from 1 to 5, the highest stays at 5: a node catching up, no new block
    for t in 0 5 10 15 20; do printf '%s\t%s\t5\n' "${t}" $((1 + t / 5)); done > "${CDIR}/catchup.tsv"
    stall_of "${CDIR}/catchup.tsv" 0 20
    want_out '^FAIL: no new block on the watched validators between 0 and 20 .*head 1 -> 5, 5 samples, 0 unreadable, highest head at the first read 5' "the lowest head catching up with a flat highest: FAIL"
    no_out '^PASS' "PASS"
    # the highest head flat for 105 s while the lowest rises to it, then both rise: FAIL on the
    # highest head's gap, though the lowest ends above the highest's first read
    { for t in $(seq 0 5 100); do printf '%s\t%s\t10\n' "${t}" $((t / 10)); done
        for t in 105 110 115 120; do printf '%s\t%s\t%s\n' "${t}" $(((t - 100) / 5 + 9)) $(((t - 100) / 5 + 10)); done; } > "${CDIR}/stall-hidden.tsv"
    stall_of "${CDIR}/stall-hidden.tsv" 0 120
    want_out '^FAIL: longest gap 105s, longest without a head read 5s \(limit 90s\), head 0 -> 13, 25 samples, 0 unreadable, highest head at the first read 10' "the highest head flat longer than the limit: FAIL"
    no_out '^PASS' "PASS"
fi
if sel monitor-blind; then
    # no node answers its head for 8 s from the restore's pg_restore (STALL_LIMIT=4 here)
    go monitor-blind FAKE_READ_OUTAGE=8 STALL_LIMIT=4
    want_rc 1
    want_out 'CHECK FAIL: other nodes never stalled while node 4 was down \(q=3, 3 live; no head read for [0-9]+s, more than 4s: a stall in that time cannot be ruled out' "rejoin: FAIL naming the missing reads"
    no_out 'CHECK PASS: other nodes never stalled' "a PASS of the stall check"
    torn_down
    go monitor-blind-isolated VARIANT=isolated FAKE_READ_OUTAGE=8 STALL_LIMIT=4
    want_rc 1
    want_out 'CHECK FAIL: the validators kept forging during the drill \(no head read for [0-9]+s, more than 4s: a stall in that time cannot be ruled out' "isolated: FAIL naming the missing reads"
    no_out 'CHECK PASS: the validators kept forging' "a PASS of the stall check"
    torn_down
fi
# The slowest watched node decides: from the backup's pg_dump to the end of the run, the
# other watched nodes stay at one head (FAKE_STUCK) or one does not answer (FAKE_SILENT)
# while the rest keep rising. The restore's pg_restore takes 6 s (FAKE_SLOW_RESTORE), so
# that lasts more than STALL_LIMIT=3 inside both variants' windows; the fake's samples
# are about 1 s apart, and the controls show the same settings pass without the fault
if sel monitor-slowest; then
    go monitor-slowest-control STALL_LIMIT=3 FAKE_SLOW_RESTORE=6
    want_out 'CHECK PASS: other nodes never stalled while node 4 was down' "rejoin, no fault, the same settings: PASS"
    go monitor-slowest-control-isolated VARIANT=isolated STALL_LIMIT=3 FAKE_SLOW_RESTORE=6
    want_out 'CHECK PASS: the validators kept forging during the drill' "isolated, no fault, the same settings: PASS"
    # rejoin watches nodes 1-3: only node 3 rises. Its window starts just after the pg_dump,
    # so the lowest head rises in it only if a read from just before the dump falls in its
    # first second; without one the reason starts with "no new block", the gap follows
    go monitor-slowest-stuck STALL_LIMIT=3 FAKE_SLOW_RESTORE=6 FAKE_STUCK=node-1,node-2
    want_rc 1
    want_out 'CHECK FAIL: other nodes never stalled while node 4 was down \(q=3, 3 live; (no new block on the watched validators between [0-9]+ and [0-9]+[^;]*; )?longest gap ([6-9]|[1-9][0-9]+)s' "rejoin, two of three stuck: FAIL on the gap"
    no_out 'CHECK PASS: other nodes never stalled' "a PASS of the stall check"
    go monitor-slowest-silent STALL_LIMIT=3 FAKE_SLOW_RESTORE=6 FAKE_SILENT=node-1
    want_rc 1
    want_out 'CHECK FAIL: other nodes never stalled while node 4 was down \(q=3, 3 live; no head read for ([6-9]|[1-9][0-9]+)s, more than 3s' "rejoin, one of three silent: FAIL naming the missing reads"
    no_out 'CHECK PASS: other nodes never stalled' "a PASS of the stall check"
    # isolated watches nodes 1-4: only node 4 rises. The lowest head at the end is the stuck
    # nodes' head at the pg_dump, which the highest at the window's first read may reach:
    # then the reason starts with "no new block", the gap follows
    go monitor-slowest-stuck-isolated VARIANT=isolated STALL_LIMIT=3 FAKE_SLOW_RESTORE=6 FAKE_STUCK=node-1,node-2,node-3
    want_rc 1
    want_out 'CHECK FAIL: the validators kept forging during the drill \((no new block on the watched validators between [0-9]+ and [0-9]+[^;]*; )?longest gap ([6-9]|[1-9][0-9]+)s' "isolated, three of four stuck: FAIL on the gap"
    no_out 'CHECK PASS: the validators kept forging' "a PASS of the stall check"
    go monitor-slowest-silent-isolated VARIANT=isolated STALL_LIMIT=3 FAKE_SLOW_RESTORE=6 FAKE_SILENT=node-1
    want_rc 1
    want_out 'CHECK FAIL: the validators kept forging during the drill \(no head read for ([6-9]|[1-9][0-9]+)s, more than 3s' "isolated, one of four silent: FAIL naming the missing reads"
    no_out 'CHECK PASS: the validators kept forging' "a PASS of the stall check"
fi
# Every watched validator stops at head 5, the height the drill waits for (FAKE_STUCK_AT),
# so no new block in either variant's window. The restore's 6 s pg_restore
# (FAKE_SLOW_RESTORE) gives the window five reads or more; with the default STALL_LIMIT
# (90) it is still far shorter than the limit. The controls show the same settings
# without the fault pass
only_stall_fail() {
    local n
    n="$(grep -c 'CHECK FAIL' "${CDIR}/out.txt")"
    if [ "${n}" = 1 ]; then ok "the stall check is the only failed check"; else bad "${n} failed checks, wanted 1 (the stall check)"; fi
}
if sel monitor-flat; then
    go monitor-flat-control FAKE_SLOW_RESTORE=6
    want_out 'CHECK PASS: other nodes never stalled while node 4 was down' "rejoin, no fault, the same settings: PASS"
    go monitor-flat-control-isolated VARIANT=isolated FAKE_SLOW_RESTORE=6
    want_out 'CHECK PASS: the validators kept forging during the drill' "isolated, no fault, the same settings: PASS"
    go monitor-flat FAKE_SLOW_RESTORE=6 FAKE_STUCK=node-1,node-2,node-3 FAKE_STUCK_AT=5
    want_rc 1
    want_out 'CHECK FAIL: other nodes never stalled while node 4 was down \(q=3, 3 live; no new block on the watched validators between [0-9]+ and [0-9]+ .*head 5 -> 5, ([5-9]|[1-9][0-9]+) samples, 0 unreadable' "rejoin, nodes 1-3 at one head: FAIL naming the window"
    no_out 'CHECK PASS: other nodes never stalled' "a PASS of the stall check"
    only_stall_fail
    go monitor-flat-isolated VARIANT=isolated FAKE_SLOW_RESTORE=6 FAKE_STUCK=node-1,node-2,node-3,node-4 FAKE_STUCK_AT=5
    want_rc 1
    want_out 'CHECK FAIL: the validators kept forging during the drill \(no new block on the watched validators between [0-9]+ and [0-9]+ .*head 5 -> 5, ([5-9]|[1-9][0-9]+) samples, 0 unreadable' "isolated, nodes 1-4 at one head: FAIL naming the window"
    no_out 'CHECK PASS: the validators kept forging' "a PASS of the stall check"
    only_stall_fail
fi
# A watched node 60 blocks behind (20 s) catches up while the others stay at the head they had
# at the backup's pg_dump (FAKE_CATCHUP, FAKE_STUCK): the lowest head keeps rising through both
# variants' windows after the dump, but no new block is made. Same settings as monitor-slowest
if sel monitor-catchup; then
    go monitor-catchup STALL_LIMIT=3 FAKE_SLOW_RESTORE=6 FAKE_STUCK=node-1,node-2 FAKE_CATCHUP=node-3:60
    want_rc 1
    want_out 'CHECK FAIL: other nodes never stalled while node 4 was down \(q=3, 3 live; (no new block on the watched validators|longest gap)' "rejoin, a node catching up, no new block: FAIL"
    no_out 'CHECK PASS: other nodes never stalled' "a PASS of the stall check"
    only_stall_fail
    go monitor-catchup-isolated VARIANT=isolated STALL_LIMIT=3 FAKE_SLOW_RESTORE=6 FAKE_STUCK=node-1,node-2,node-4 FAKE_CATCHUP=node-3:60
    want_rc 1
    want_out 'CHECK FAIL: the validators kept forging during the drill \((no new block on the watched validators|longest gap)' "isolated, a node catching up, no new block: FAIL"
    no_out 'CHECK PASS: the validators kept forging' "a PASS of the stall check"
    only_stall_fail
fi

# ── one run per project, a new OUT_DIR per run ──────────────────────────
if sel project-lock; then
    # the lock of demos-faketest held here, as by a run that has not finished its teardown
    mkdir -p "${WORK}/project-lock"
    exec 8>> "${WORK}/project-lock/demos-faketest.lock"
    flock -n 8
    go project-lock SMOKE=1
    want_rc 2
    want_out "another run of PROJECT demos-faketest holds ${CDIR}/demos-faketest.lock" "the refusal names the lock"
    if [ ! -s "${CDIR}/calls.log" ]; then ok "docker never called"; else bad "docker was called"; fi
    if [ -z "$(ls -A "${CDIR}/runs")" ]; then ok "no run dir written"; else bad "a run dir was written"; fi
    # another project, its lock in the same dir, runs meanwhile
    go project-lock-other SMOKE=1 LOCK_DIR="${WORK}/project-lock" PROJECT=demos-faketest2
    want_rc 0
    # the default run dir is named after the project too
    if ls "${CDIR}/runs" | grep -qE '^[0-9]{8}T[0-9]{6}Z-demos-faketest2-bkdrill-smoke$'; then
        ok "the default OUT_DIR name holds PROJECT"
    else bad "default OUT_DIR name without PROJECT: $(ls "${CDIR}/runs")"; fi
    exec 8>&-
fi
if sel out-dir-used; then
    # an OUT_DIR that holds an earlier run's checks.tsv
    d="${WORK}/out-dir-used/earlier"
    mkdir -p "${d}"
    printf 'earlier\tPASS\tkept\n' > "${d}/checks.tsv"
    go out-dir-used SMOKE=1 OUT_DIR="${d}"
    want_rc 2
    want_out "OUT_DIR ${d} already exists" "the refusal names OUT_DIR"
    if [ "$(ls -A "${d}")" = checks.tsv ] && [ "$(cat "${d}/checks.tsv")" = "$(printf 'earlier\tPASS\tkept')" ]; then
        ok "the earlier checks.tsv untouched, nothing added"
    else bad "OUT_DIR was written to"; fi
    if [ ! -s "${CDIR}/calls.log" ]; then ok "docker never called"; else bad "docker was called"; fi
    # an existing empty OUT_DIR is refused too: it may be another run's, just created
    d="${WORK}/out-dir-empty/new"
    mkdir -p "${d}"
    go out-dir-empty SMOKE=1 OUT_DIR="${d}"
    want_rc 2
    want_out "OUT_DIR ${d} already exists; every run needs a new dir, so an existing one is refused even when empty" "the refusal names OUT_DIR"
    if [ -z "$(ls -A "${d}")" ]; then ok "the empty OUT_DIR is still empty"; else bad "OUT_DIR was written to"; fi
    if [ ! -s "${CDIR}/calls.log" ]; then ok "docker never called"; else bad "docker was called"; fi
    if [ ! -e "${CDIR}/demos-faketest.lock" ]; then ok "no lock file written"; else bad "the lock file was written"; fi
fi
if sel out-dir-same-second; then
    # two runs of one PROJECT started in the same second get the same default OUT_DIR: here
    # that of each of the next 10 seconds already holds another run's checks.tsv
    d="${WORK}/out-dir-same-second/runs"
    mkdir -p "${d}"
    s0="$(date -u +%s)"
    for k in $(seq 0 10); do
        mkdir -p "${d}/$(date -u -d "@$((s0 + k))" +%Y%m%dT%H%M%SZ)-demos-faketest-bkdrill-smoke"
        printf 'other\tPASS\tkept\n' > "${d}/$(date -u -d "@$((s0 + k))" +%Y%m%dT%H%M%SZ)-demos-faketest-bkdrill-smoke/checks.tsv"
    done
    go out-dir-same-second SMOKE=1
    want_rc 2
    want_out "OUT_DIR ${d}/[0-9]{8}T[0-9]{6}Z-demos-faketest-bkdrill-smoke already exists" "the second run is refused"
    if [ "$(cat "${d}"/*/checks.tsv | sort -u)" = "$(printf 'other\tPASS\tkept')" ] && [ "$(ls -A "${d}"/* | grep -cv -e checks.tsv -e '^$' -e ':$')" = 0 ]; then
        ok "the other run's dirs untouched, nothing added"
    else bad "another run's OUT_DIR was written to"; fi
    if [ ! -s "${CDIR}/calls.log" ]; then ok "docker never called"; else bad "docker was called"; fi
fi

echo
echo "fake-docker tests: ${PASS} passed, ${FAIL} failed (work dir ${WORK})"
if [ "${FAIL}" = 0 ]; then rm -rf "${WORK}"; exit 0; fi
exit 1
