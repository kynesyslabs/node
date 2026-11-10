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
        export FAKE_DIR="${CDIR}" RUNS_DIR="${CDIR}/runs"
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
    want_call 'up --no-start' "up --no-start (volumes created by compose)"
    no_call 'compose.* run --rm --no-deps -T -e PG_HOST=pg-iso' "the isolated node's migration"
    no_out 'PHASE A ' "any drill phase (backup)"
    torn_down
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
    want_out 'CHECK PASS: restored head >= pre-wipe head' "head after restore"
    want_out 'RESULT PASS: rejoin drill' "result PASS"
    no_out 'CHECK FAIL' "any failed check"
    want_out 'left on the state volume: node.identity node.identity.prevote.json node.identity.signed.json' "wipe kept only identity and signing state"
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
    want_out 'RESULT PASS: isolated drill' "result PASS"
    no_out 'CHECK FAIL' "any failed check"
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

# ── the manual migration of the restored database ───────────────────────
node4_starts() { grep -cE 'up -d --no-deps --pull never node-4$' "${CDIR}/calls.log"; }
if sel migrate-fail; then
    go migrate-fail FAKE_MIGRATE_FAIL=1
    want_rc 2
    want_out "WARNING: migrations on node 4's database failed" "bring-up only warns"
    want_out 'migrations failed on the restored database' "the restore stops on it"
    if [ "$(node4_starts)" = 1 ]; then ok "node-4 not started after the failed migration"; else bad "node-4 start count $(node4_starts), wanted 1 (bring-up only)"; fi
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

echo
echo "fake-docker tests: ${PASS} passed, ${FAIL} failed (work dir ${WORK})"
if [ "${FAIL}" = 0 ]; then rm -rf "${WORK}"; exit 0; fi
exit 1
