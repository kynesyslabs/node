#!/usr/bin/env bash
# Stub tests of cloud-drill.sh: the plan it derives from an inventory, the
# options it refuses, and a whole campaign over stubbed hosts. ssh runs the
# remote command line through sh in a directory per host, with `docker`,
# `ping` and `timedatectl` stand-ins first on its PATH; run.sh is a stub that
# leaves the run dir a real run leaves. Nothing leaves this machine.
#
#   bash testing/devnet/quorum-drills/cloud-drill-stub.test.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK=$(mktemp -d)
trap 'rm -rf "${WORK}"' EXIT
fails=0
shown=0
# A failed check prints what the cloud-drill run before it said, once per run
check() {
    local what="$1"; shift
    if "$@"; then echo "  ok   ${what}"; return; fi
    echo "  FAIL ${what}"; fails=$((fails + 1))
    [ "${shown}" = 0 ] && [ -f "${WORK}/out" ] || return 0
    shown=1
    echo "  ---- cloud-drill stdout"; sed 's/^/  | /' "${WORK}/out"
    echo "  ---- cloud-drill stderr"; sed 's/^/  | /' "${WORK}/err"
}
IMAGE="ghcr.io/kynesyslabs/node:v1.0.0-rc.13@sha256:$(printf '%064d' 7)"
export STUB_WORK="${WORK}"

mkdir -p "${WORK}/bin" "${WORK}/remote/bin"
cat > "${WORK}/bin/ssh" <<'EOF'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do
    case "$1" in -o | -i | -p) shift 2 ;; -O) exit 0 ;; *) break ;; esac
done
host="$1"; shift
h="${host#*@}"
mkdir -p "${STUB_WORK}/hosts/${h}"
echo "${h} $*" >> "${STUB_WORK}/ssh-calls"
cd "${STUB_WORK}/hosts/${h}" || exit 255
HOME="${STUB_WORK}/hosts/${h}" STUB_HOST="${h}" PATH="${STUB_WORK}/remote/bin:${PATH}" sh -c "$*"
EOF
# The remote docker: a version, and leftovers only where STUB_LEFT (a container)
# or STUB_LEFT_NET (a network) names the host
cat > "${WORK}/remote/bin/docker" <<'EOF'
#!/usr/bin/env bash
case "$1" in
    version) echo 27.3.1 ;;
    ps) [ "${STUB_LEFT:-}" = "${STUB_HOST}" ] && echo abc123 ;;
    network) [ "${STUB_LEFT_NET:-}" = "${STUB_HOST}" ] && echo net123 ;;
    volume) ;;
esac
exit 0
EOF
cat > "${WORK}/remote/bin/ping" <<'EOF'
#!/usr/bin/env bash
echo "rtt min/avg/max/mdev = 1.000/12.500/20.000/0.100 ms"
EOF
cat > "${WORK}/remote/bin/timedatectl" <<'EOF'
#!/usr/bin/env bash
echo yes
EOF
# date on a host: STUB_SKEW_MS ahead of this machine for +%s%3N
cat > "${WORK}/remote/bin/date" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "+%s%3N" ] && [ -n "${STUB_SKEW_MS:-}" ]; then echo $(( $(/bin/date +%s%3N) + STUB_SKEW_MS )); exit 0; fi
exec /bin/date "$@"
EOF
# run.sh: the run dir of a real run, with keys and inputs the evidence must leave out;
# exits 1 for halt-*, so the campaign reports the worst
cat > "${WORK}/run.sh" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "${STUB_WORK}/run-calls"
env | grep -E '^(HEADROOM_MB|BIND_HOST_IP)=' >> "${STUB_WORK}/run-env"
while [ $# -gt 2 ]; do shift; done
s="$1"; label="$2"
d="${RUNS_DIR}/20261118T000000Z-${s}-on-${label}"
mkdir -p "${d}/logs" "${d}/inputs" "${d}/hosts/1/inputs"
echo secret > "${d}/inputs/node-1.identity"
echo secret > "${d}/hosts/1/inputs/node-1.identity"
echo secret > "${d}/load-wallet.identity"
result=PASS; rc=0
case "${s}" in halt-*) result=FAIL; rc=1 ;; esac
printf '{"result":"%s","detail":"stub","drill":{"summary":"stub summary %s"}}\n' "${result}" "${s}" > "${d}/logs/verdict.json"
echo '{"roles":{"node":{"containers":4,"memPeakMiBMax":640.5,"memPeakMiBMean":600,"cpuMeanPct":35.2,"cpuPeakPctMax":180,"netMBPerHourMean":40.1,"netMBPerHourMax":55}},"containers":{},"skipped":0}' > "${d}/resources-summary.json"
case "${s}" in load-*) echo '{"metrics":{"mainTps":1.9,"offeredTps":2,"includedRatio":0.99,"blockTimeS":{"p50":10,"p95":11},"timeToInclusionS":{"p50":8,"p95":12}}}' > "${d}/drill-verdict.json" ;; esac
if [ -n "${STUB_DIRTY:-}" ]; then
    echo "LEFT BEHIND: host 1: volume qdrill-x_node-1-data;" > "${d}/teardown-check.txt"
else
    echo "clean: no container, network or volume of qdrill-x left on 2 host(s); 12 volume(s) removed" > "${d}/teardown-check.txt"
fi
printf 'run\tscenario\n%s\t%s\n' "${d##*/}" "${s}" >> "${RUNS_DIR}/results.tsv"
echo "[qdrill 00:00:00] RESULT ${result}: ${s}"
exit "${rc}"
EOF
chmod +x "${WORK}"/bin/* "${WORK}"/remote/bin/* "${WORK}/run.sh"
export PATH="${WORK}/bin:${PATH}" RUN_SH="${WORK}/run.sh" CAMPAIGNS_DIR="${WORK}/campaigns"
# The stub hosts have no clock offset, so what cloud-drill.sh measures is the
# ssh round trip: a runner stall there adds about half its length, and over the
# 500 ms default the campaign aborts before any scenario or leftovers.txt
# (#1275). Every case runs with a bound no stall reaches; the clock case sets
# the default back.
export CLOCK_MAX_MS=600000

inv() { printf '%s\n' "$@" > "${WORK}/inv"; }
cloud() { shown=0; bash "${HERE}/cloud-drill.sh" "$@" > "${WORK}/out" 2> "${WORK}/err"; }
last_campaign() { ls -1dt "${CAMPAIGNS_DIR}"/*-"$1"* | head -1; }

echo "plan"
cloud --inventory "${HERE}/inventory.example" --image "${IMAGE}" --dry-run plan; rc=$?
check "the example inventory: exit 0" [ "${rc}" = 0 ]
check "the example inventory: 30 validators on 10 hosts, q 7, tolerance 3" grep -q "30 validators on 10 hosts, shardSize 10, q 7, guaranteed tolerance 3" "${WORK}/out"
check "the example inventory: every default scenario at n30s10, hostloss included" \
    grep -q "plan: restart-n30s10 third-n30s10 hostloss-n30s10 halt-n30s10 load-n30s10" "${WORK}/out"
check "the example inventory: run.sh gets the hosts file and the image" grep -q -- "--hosts .*/hosts --image ${IMAGE} load-n30s10 plan" "${WORK}/out"
inv "10.0.0.1 u 22 4" "10.0.0.2 u 22 4" "10.0.0.3 u 22 4"
cloud --inventory "${WORK}/inv" --image "${IMAGE}" --scenarios hostloss,restart --dry-run p2
check "4 validators a host: hostloss skipped, over the tolerance of 3" grep -q "skip hostloss: the last host runs 4 validators, more than the 3" "${WORK}/out"
check "4 validators a host: the rest runs" grep -q "plan: restart-n12s10$" "${WORK}/out"
inv "10.0.0.1 u 2222 6"
cloud --inventory "${WORK}/inv" --image "${IMAGE}" --scenarios "hostloss" --shard 4 --dry-run p3; rc=$?
check "one host: hostloss skipped, nothing left to run, exit 2" [ "${rc}" = 2 ]
check "one host: says why" grep -q "skip hostloss: one host" "${WORK}/out"

echo "refusals"
inv "10.0.0.1 u 22 3" "10.0.0.2 u 22 3"
for c in "no digest|--image ghcr.io/kynesyslabs/node:v1.0.0-rc.13|must be a registry reference by digest" \
    "unknown scenario|--image ${IMAGE} --scenarios restart,fly|unknown scenario kind 'fly'" \
    "allow-from without prepare|--image ${IMAGE} --allow-from 1.2.3.4|--allow-from needs --prepare" \
    "shard above validators|--image ${IMAGE} --shard 7|--shard 7 is above the 6 validators"; do
    IFS='|' read -r what args msg <<< "${c}"
    # shellcheck disable=SC2086
    cloud --inventory "${WORK}/inv" ${args} --dry-run r; rc=$?
    check "${what}: exit 2" [ "${rc}" = 2 ]
    check "${what}: says so" grep -qF -- "${msg}" "${WORK}/err"
done
inv "10.0.0.1 u 22 2" "10.0.0.2 u 22 1"
cloud --inventory "${WORK}/inv" --image "${IMAGE}" --dry-run r; rc=$?
check "3 validators: exit 2" [ "${rc}" = 2 ]
check "3 validators: says the drills need 4" grep -q "need at least 4" "${WORK}/err"
inv "10.0.0.1 u 22 three"
cloud --inventory "${WORK}/inv" --image "${IMAGE}" --dry-run r; rc=$?
check "a malformed inventory: exit 2 with the line" bash -c "[ ${rc} = 2 ] && grep -q 'line 1: validators must be' '${WORK}/err'"

echo "campaign"
inv "10.0.0.1 drill 22 3" "10.0.0.2 drill 2222 3"
rm -f "${WORK}/run-calls" "${WORK}/run-env"
cloud --inventory "${WORK}/inv" --image "${IMAGE}" --scenarios "restart halt load" --shard 6 full; rc=$?
C=$(last_campaign full)
check "a failed scenario: exit 1" [ "${rc}" = 1 ]
check "run.sh ran once per scenario, in order" diff <(cut -d' ' -f5 "${WORK}/run-calls") <(printf '%s\n' restart-n6s6 halt-n6s6 load-n6s6)
check "run.sh got HEADROOM_MB=1536 and BIND_HOST_IP=0" bash -c "grep -qx HEADROOM_MB=1536 '${WORK}/run-env' && grep -qx BIND_HOST_IP=0 '${WORK}/run-env'"
# The offset's size is the clock case's: here a stall can make it any size
check "hosts.tsv: both hosts with their facts and an offset in whole ms" \
    bash -c "awk -F'\t' -v max=${CLOCK_MAX_MS} 'NR > 1 && \$8 == \"27.3.1\" && \$9 == \"yes\" && \$10 ~ /^-?[0-9]+\$/ && \$10 <= max && \$10 >= -max' '${C}/hosts.tsv' | wc -l | grep -qx 2"
check "ping matrix: 2 x 2 at 12.500 ms" bash -c "grep -c $'\t12.500\t12.500$' '${C}/ping-matrix.tsv' | grep -qx 2"
check "results.tsv: halt FAIL with exit 1, load PASS" \
    bash -c "grep -q $'^halt-n6s6\t1\tFAIL\t' '${C}/results.tsv' && grep -q $'^load-n6s6\t0\tPASS\t' '${C}/results.tsv'"
check "evidence: one dir per run" bash -c "ls '${C}/evidence' | grep -c -- '-on-full$' | grep -qx 3"
check "evidence: no inputs, hosts or key file" bash -c "! find '${C}/evidence' \( -name inputs -o -name hosts -o -name '*.identity' \) | grep -q ."
check "the run dirs: inputs and hosts removed after the copy" bash -c "! find '${C}/runs' \( -name inputs -o -name hosts \) | grep -q ."
check "summary.md: results, load metrics, resources, teardown" bash -c "
    grep -q '^| halt-n6s6 | 1 | FAIL |' '${C}/summary.md' &&
    grep -q 'main TPS 1.9 at 2 offered' '${C}/summary.md' &&
    grep -q 'node (4): memory peak max 640.5 MiB' '${C}/summary.md' &&
    grep -q 'judge: stub summary load-n6s6' '${C}/summary.md' &&
    grep -q '^- teardown: clean' '${C}/summary.md' &&
    grep -q '^clean: no drill container, network, labelled volume or run dir on 2 hosts' '${C}/summary.md'"
check "the campaign dir is private" bash -c "[ \"\$(stat -c %a '${C}')\" = 700 ]"

echo "leftovers"
STUB_LEFT=10.0.0.2 cloud --inventory "${WORK}/inv" --image "${IMAGE}" --scenarios restart --shard 6 left; rc=$?
C=$(last_campaign left)
check "a container left on host 2: exit 2" [ "${rc}" = 2 ]
check "a container left on host 2: leftovers.txt names it" grep -q "LEFT BEHIND: host 2: 1 containers, 0 networks, 0 volumes, 0 run dirs;" "${C}/leftovers.txt"
STUB_LEFT_NET=10.0.0.1 cloud --inventory "${WORK}/inv" --image "${IMAGE}" --scenarios restart --shard 6 leftnet; rc=$?
C=$(last_campaign leftnet)
check "a network left on host 1: exit 2" [ "${rc}" = 2 ]
check "a network left on host 1: leftovers.txt names it" grep -q "LEFT BEHIND: host 1: 0 containers, 1 networks, 0 volumes, 0 run dirs;" "${C}/leftovers.txt"
STUB_DIRTY=1 cloud --inventory "${WORK}/inv" --image "${IMAGE}" --scenarios restart --shard 6 dirty; rc=$?
C=$(last_campaign dirty)
check "a PASS run whose own teardown left a volume: exit 2" [ "${rc}" = 2 ]
check "that run counts as exit 2 in results.tsv" grep -q $'^restart-n6s6\t2\tPASS\t' "${C}/results.tsv"

echo "clock"
CLOCK_MAX_MS=500 STUB_SKEW_MS=4000 cloud --inventory "${WORK}/inv" --image "${IMAGE}" --scenarios restart --shard 6 skew; rc=$?
check "a host 4 s off: exit 2" [ "${rc}" = 2 ]
check "a host 4 s off: says so, no scenario run" bash -c "grep -q 'clock offset above 500ms' '${WORK}/out' && ! grep -q skew '${WORK}/run-calls'"

echo "prepare"
inv "10.0.0.1 drill 22 3" "10.0.0.2 drill 2222 3"
cat > "${WORK}/remote/bin/sudo" <<'EOF'
#!/usr/bin/env bash
[ "$1" = -n ] && shift
echo "$*" > "${HOME}/prepare-args"
cat > "${HOME}/prepare-script"
EOF
chmod +x "${WORK}/remote/bin/sudo"
cloud --inventory "${WORK}/inv" --image "${IMAGE}" --scenarios restart --shard 6 --prepare --allow-from 10.0.0.0/24,192.0.2.7 prep; rc=$?
check "prepare: exit 0" [ "${rc}" = 0 ]
check "prepare: prepare-host.sh fed to every host" bash -c "cmp -s '${HERE}/prepare-host.sh' '${WORK}/hosts/10.0.0.1/prepare-script' && cmp -s '${HERE}/prepare-host.sh' '${WORK}/hosts/10.0.0.2/prepare-script'"
check "prepare: with the user, the node count, its ssh port and each allowed address" \
    grep -qx "bash -s -- --user drill --nodes 6 --ssh-port 22 --allow-from 10.0.0.0/24 --allow-from 192.0.2.7" "${WORK}/hosts/10.0.0.1/prepare-args"
check "prepare: a host on ssh port 2222 keeps 2222 open" grep -q -- "--ssh-port 2222 " "${WORK}/hosts/10.0.0.2/prepare-args"

echo
if [ "${fails}" = 0 ]; then echo "cloud-drill stub tests: all passed"; else echo "cloud-drill stub tests: ${fails} FAILED"; exit 1; fi
