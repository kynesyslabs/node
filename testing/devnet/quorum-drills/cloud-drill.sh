#!/usr/bin/env bash
# The quorum drills on rented hosts, one command (README.md "Cloud drill").
#
#   cloud-drill.sh --inventory FILE --image REF@sha256:<digest> [options] [label]
#
#   --inventory FILE    one host per line: `address ssh_user ssh_port validators`
#                       (inventory.example); the only provider-specific input
#   --image REF         the release image, by digest (every host runs the same bytes)
#   --scenarios LIST    drill kinds to run in order, space or comma separated
#                       (default: restart third hostloss halt load); each runs
#                       as run.sh <kind>-n<N>s<S>, N the inventory's validators
#   --shard S           committee size (default 10)
#   --prepare           run prepare-host.sh on every host first, through
#                       `sudo -n` (passwordless sudo for the ssh user)
#   --allow-from LIST   with --prepare: comma-separated addresses or CIDRs the
#                       node ports are opened to (default: every inventory
#                       address and this controller's public address)
#   --carryover         run.sh --carryover: the identityCarryover snapshot too
#   --netem SPEC        run.sh --netem SPEC on every scenario
#   --dry-run           print the plan and the run.sh commands, contact no host
#
# Steps: the inventory becomes a run.sh hosts file; [prepare]; host facts, clock
# offsets and an inter-host ping matrix (a host whose clock is off by more than
# CLOCK_MAX_MS ends the campaign: node logs are read by time); one run.sh --hosts
# per scenario; the evidence of every run (keys left out) and summary.md in
# campaigns/<time>-<label>/; last, a check that no drill container, volume or
# run dir is left on any host.
#
# Environment: REGISTRY_TOKEN [REGISTRY_USER] for a private registry (HOSTS.md);
# QDRILL_SSH_IDENTITY, QDRILL_SSH_KNOWN_HOSTS, QDRILL_SSH_ACCEPT_NEW; CAMPAIGNS_DIR;
# CLOCK_MAX_MS (500); HEADROOM_MB (1536: hosts run nothing else) and every other
# run.sh variable (LOAD_TPS, CONSENSUS_TIME, ...), passed through; RUN_SH, the
# run.sh to call (the stub tests replace it).
# Exit codes: 0 every scenario passed, 1 one failed, 2 one could not run, the
# setup failed, or a host was left with drill containers, volumes or run dirs.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SH="${RUN_SH:-${HERE}/run.sh}"

INVENTORY=""
IMAGE=""
SCENARIOS="restart third hostloss halt load"
SHARD=10
PREPARE=0
ALLOW_FROM=""
CARRYOVER=0
NETEM=""
DRY_RUN=0
CLOCK_MAX_MS="${CLOCK_MAX_MS:-500}"
export HEADROOM_MB="${HEADROOM_MB:-1536}"
export BIND_HOST_IP="${BIND_HOST_IP:-1}"

usage() { sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
    case "$1" in
        --inventory) INVENTORY="$2"; shift 2 ;;
        --image) IMAGE="$2"; shift 2 ;;
        --scenarios) SCENARIOS="${2//,/ }"; shift 2 ;;
        --shard) SHARD="$2"; shift 2 ;;
        --prepare) PREPARE=1; shift ;;
        --allow-from) ALLOW_FROM="$2"; shift 2 ;;
        --carryover) CARRYOVER=1; shift ;;
        --netem) NETEM="$2"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h | --help) usage; exit 0 ;;
        --*) echo "unknown option $1" >&2; usage >&2; exit 2 ;;
        *) break ;;
    esac
done
LABEL="${1:-cloud}"
[[ "${LABEL}" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "label must match [A-Za-z0-9_-]+" >&2; exit 2; }
[ -r "${INVENTORY}" ] || { echo "--inventory: cannot read '${INVENTORY}'" >&2; exit 2; }
[[ "${IMAGE}" =~ ^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$ ]] ||
    { echo "--image must be a registry reference by digest (REF@sha256:<64 hex>), got '${IMAGE}'" >&2; exit 2; }
[[ "${SHARD}" =~ ^[1-9][0-9]*$ ]] || { echo "--shard must be a positive integer" >&2; exit 2; }
[[ "${CLOCK_MAX_MS}" =~ ^[0-9]+$ ]] || { echo "CLOCK_MAX_MS must be a whole number of ms" >&2; exit 2; }
for k in ${SCENARIOS}; do
    case "${k}" in restart | third | hostloss | halt | ride | load) ;; *) echo "unknown scenario kind '${k}'" >&2; exit 2 ;; esac
done
[ "${PREPARE}" = 1 ] || [ -z "${ALLOW_FROM}" ] || { echo "--allow-from needs --prepare" >&2; exit 2; }

CAMPAIGNS_DIR="${CAMPAIGNS_DIR:-${HERE}/campaigns}"
mkdir -p "${CAMPAIGNS_DIR}" || exit 2
# mkdir, not mkdir -p: a campaign started in the same second takes the next suffix
CAMPAIGN_BASE="${CAMPAIGNS_DIR}/$(date -u +%Y%m%dT%H%M%SZ)-${LABEL}"
CAMPAIGN="${CAMPAIGN_BASE}"
for k in $(seq 2 100); do
    mkdir -m 700 "${CAMPAIGN}" 2>/dev/null && break
    [ "${k}" = 100 ] && { echo "could not create ${CAMPAIGN}" >&2; exit 2; }
    CAMPAIGN="${CAMPAIGN_BASE}-${k}"
done
LOG="${CAMPAIGN}/campaign.log"
say() { echo "[cloud $(date -u +%H:%M:%S)] $*" | tee -a "${LOG}"; }
show_tsv() { if command -v column > /dev/null; then column -t -s $'\t' "$1"; else cat "$1"; fi; }

# ── inventory ───────────────────────────────────────────────────────────
HOSTS="${CAMPAIGN}/hosts"
counts=$(python3 -I "${HERE}/drill_inputs.py" inventory --file "${INVENTORY}" --hosts-out "${HOSTS}" 2>&1) ||
    { echo "${counts}" >&2; exit 2; }
read -r N HOST_COUNT <<< "${counts}"
[ "${N}" -ge 4 ] || { echo "the inventory runs ${N} validators; the drills need at least 4" >&2; exit 2; }
[ "${SHARD}" -le "${N}" ] || { echo "--shard ${SHARD} is above the ${N} validators" >&2; exit 2; }
# user@ip port validators, per host in inventory order
mapfile -t HOST_LINES < <(sed -E 's/^([^ :]+):([0-9]+) ([0-9]+)$/\1 \2 \3/' "${HOSTS}")
Q=$(( SHARD * 2 / 3 + 1 ))
TOLERANCE=$(( (SHARD < N ? SHARD : N) - Q ))
say "inventory: ${N} validators on ${HOST_COUNT} hosts, shardSize ${SHARD}, q ${Q}, guaranteed tolerance ${TOLERANCE}"

# The hostloss drill stops the last host's validators: meaningful only within the tolerance
LAST_HOST_VALIDATORS=$(awk 'END { print $3 }' <<< "$(printf '%s\n' "${HOST_LINES[@]}")")
PLAN=()
for k in ${SCENARIOS}; do
    if [ "${k}" = hostloss ]; then
        if [ "${HOST_COUNT}" -lt 2 ]; then say "skip hostloss: one host"; continue; fi
        if [ "${LAST_HOST_VALIDATORS}" -gt "${TOLERANCE}" ]; then
            say "skip hostloss: the last host runs ${LAST_HOST_VALIDATORS} validators, more than the ${TOLERANCE} a committee of ${SHARD} tolerates"
            continue
        fi
    fi
    PLAN+=("${k}-n${N}s${SHARD}")
done
[ "${#PLAN[@]}" -gt 0 ] || { say "nothing to run"; exit 2; }
RUN_ARGS=(--hosts "${HOSTS}" --image "${IMAGE}")
[ "${CARRYOVER}" = 1 ] && RUN_ARGS+=(--carryover)
[ -n "${NETEM}" ] && RUN_ARGS+=(--netem "${NETEM}")
say "plan: ${PLAN[*]}"

if [ "${DRY_RUN}" = 1 ]; then
    for s in "${PLAN[@]}"; do echo "would run: RUNS_DIR=${CAMPAIGN}/runs HEADROOM_MB=${HEADROOM_MB} BIND_HOST_IP=${BIND_HOST_IP} ${RUN_SH} ${RUN_ARGS[*]} ${s} ${LABEL}"; done
    exit 0
fi

# ── ssh ─────────────────────────────────────────────────────────────────
# The ssh options run.sh uses (multihost.sh), so host keys and identity are
# handled the same way in both
# shellcheck source=multihost.sh
source "${HERE}/multihost.sh"
hssh() { # $1 index into HOST_LINES, then the remote command line
    local t p _
    read -r t p _ <<< "${HOST_LINES[$1]}"; shift
    ssh "${MH_SSH_OPTS[@]}" -p "${p}" "${t}" "$@"
}
close_masters() {
    local i t p _
    for i in "${!HOST_LINES[@]}"; do
        read -r t p _ <<< "${HOST_LINES[i]}"
        ssh "${MH_SSH_OPTS[@]}" -p "${p}" -O exit "${t}" > /dev/null 2>&1 || true
    done
}
trap close_masters EXIT
host_addr() { local t _; read -r t _ <<< "${HOST_LINES[$1]}"; echo "${t#*@}"; }
host_user() { local t _; read -r t _ <<< "${HOST_LINES[$1]}"; echo "${t%@*}"; }

# ── prepare ─────────────────────────────────────────────────────────────
if [ "${PREPARE}" = 1 ]; then
    if [ -z "${ALLOW_FROM}" ]; then
        me=$(curl -fsS -m 10 https://checkip.amazonaws.com 2>/dev/null | tr -dc '0-9.')
        [ -n "${me}" ] || say "WARN: could not learn this controller's public address: only the hosts may reach the node ports"
        ALLOW_FROM=$(for i in "${!HOST_LINES[@]}"; do host_addr "${i}"; done | paste -sd,)${me:+,${me}}
    fi
    allow_args=()
    for a in ${ALLOW_FROM//,/ }; do allow_args+=(--allow-from "${a}"); done
    say "prepare: prepare-host.sh on ${HOST_COUNT} hosts, node ports open to ${ALLOW_FROM}"
    pids=()
    for i in "${!HOST_LINES[@]}"; do
        hssh "${i}" "sudo -n bash -s -- --user $(mh_q "$(host_user "${i}")") --nodes ${N} $(mh_q "${allow_args[@]}")" \
            < "${HERE}/prepare-host.sh" > "${CAMPAIGN}/prepare-$((i + 1)).log" 2>&1 &
        pids+=("$!")
    done
    for i in "${!pids[@]}"; do
        wait "${pids[i]}" || { say "ABORT: prepare-host.sh failed on host $((i + 1)) (see prepare-$((i + 1)).log)"; exit 2; }
    done
    # The docker group takes effect at the next login: drop the masters made before it
    close_masters
fi

# ── host facts, clocks, ping matrix ─────────────────────────────────────
say "host facts"
printf 'host\taddress\tvalidators\tcpus\tmem_mib\tdisk_free_gib\tkernel\tdocker\tntp_synced\toffset_ms\n' > "${CAMPAIGN}/hosts.tsv"
clock_bad=""
for i in "${!HOST_LINES[@]}"; do
    read -r _ _ v <<< "${HOST_LINES[i]}"
    facts=$(hssh "${i}" 'printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "$(nproc)" "$(free -m | awk "/^Mem:/{print \$2}")" \
        "$(df -BG --output=avail / | tail -1 | tr -dc 0-9)" "$(uname -r)" "$(docker version --format "{{.Server.Version}}" 2>/dev/null || echo none)" \
        "$(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo unknown)" ""' < /dev/null 2>> "${LOG}") ||
        { say "ABORT: host $((i + 1)) ($(host_addr "${i}")): ssh failed (see campaign.log)"; exit 2; }
    # The clock alone, on the connection the facts call opened, against the
    # midpoint of the round trip: the facts take long enough to skew it
    t0=$(date +%s%3N)
    remote_ms=$(hssh "${i}" 'date +%s%3N' < /dev/null 2>> "${LOG}")
    t1=$(date +%s%3N)
    [[ "${remote_ms}" =~ ^[0-9]+$ ]] || { say "ABORT: host $((i + 1)): could not read its clock"; exit 2; }
    offset=$(( remote_ms - (t0 + t1) / 2 ))
    printf '%s\t%s\t%s\t%s\t%s\n' "$((i + 1))" "$(host_addr "${i}")" "${v}" "$(cut -f1-6 <<< "${facts}")" "${offset}" >> "${CAMPAIGN}/hosts.tsv"
    [ "${offset#-}" -le "${CLOCK_MAX_MS}" ] || clock_bad+=" host $((i + 1)) ${offset}ms"
done
show_tsv "${CAMPAIGN}/hosts.tsv" | tee -a "${LOG}"
[ -z "${clock_bad}" ] || { say "ABORT: clock offset above ${CLOCK_MAX_MS}ms:${clock_bad} (chrony or timesyncd on the hosts)"; exit 2; }

say "ping matrix (ms, avg of 3)"
addrs=$(for i in "${!HOST_LINES[@]}"; do host_addr "${i}"; done | paste -sd' ')
pids=()
for i in "${!HOST_LINES[@]}"; do
    hssh "${i}" "for a in ${addrs}; do r=\$(ping -c 3 -i 0.2 -q -W 2 \"\$a\" 2>/dev/null | awk -F/ '/^rtt|^round-trip/ {print \$5}'); printf '%s ' \"\${r:-x}\"; done; echo" \
        < /dev/null > "${CAMPAIGN}/ping-$((i + 1)).txt" 2>> "${LOG}" &
    pids+=("$!")
done
for p in "${pids[@]}"; do wait "${p}"; done
{
    printf 'from\\to'; for i in "${!HOST_LINES[@]}"; do printf '\t%s' "$((i + 1))"; done; echo
    for i in "${!HOST_LINES[@]}"; do printf '%s' "$((i + 1))"; for r in $(cat "${CAMPAIGN}/ping-$((i + 1)).txt"); do printf '\t%s' "${r}"; done; echo; done
} > "${CAMPAIGN}/ping-matrix.tsv"
rm -f "${CAMPAIGN}"/ping-*.txt
show_tsv "${CAMPAIGN}/ping-matrix.tsv" | tee -a "${LOG}"
close_masters

# ── scenarios ───────────────────────────────────────────────────────────
mkdir -p "${CAMPAIGN}/runs" "${CAMPAIGN}/evidence"
worst=0
printf 'scenario\texit\tresult\tminutes\trun\n' > "${CAMPAIGN}/results.tsv"
for s in "${PLAN[@]}"; do
    say "── ${s}"
    t0=${SECONDS}
    RUNS_DIR="${CAMPAIGN}/runs" "${RUN_SH}" "${RUN_ARGS[@]}" "${s}" "${LABEL}" 2>&1 | tee -a "${LOG}" | grep --line-buffered -E '^\[qdrill [0-9:]+\] (──|RESULT|ABORT|FAIL|WARN|teardown)'
    rc=${PIPESTATUS[0]}
    run=$(ls -1d "${CAMPAIGN}/runs/"*"-${s}-${BINDING:-on}-${LABEL}"* 2>/dev/null | tail -1)
    result=$(jq -r .result "${run}/logs/verdict.json" 2>/dev/null || echo none)
    printf '%s\t%s\t%s\t%s\t%s\n' "${s}" "${rc}" "${result}" $(( (SECONDS - t0 + 59) / 60 )) "${run##*/}" >> "${CAMPAIGN}/results.tsv"
    [ "${rc}" -gt "${worst}" ] && worst="${rc}"
    # The evidence, without the throwaway keys and inputs the run dir also holds
    if [ -n "${run}" ]; then
        tar -C "${run}" --exclude='./inputs' --exclude='./hosts' --exclude='./mhbin' --exclude='./carryover-src' \
            --exclude='*.identity' -cf - . | { mkdir -p "${CAMPAIGN}/evidence/${run##*/}" && tar -C "${CAMPAIGN}/evidence/${run##*/}" -xf -; }
        rm -rf "${run:?}/inputs" "${run:?}/hosts"
    fi
done
[ "${worst}" -gt 2 ] && worst=2
cp -f "${CAMPAIGN}/runs/results.tsv" "${CAMPAIGN}/run-results.tsv" 2>/dev/null || true

# ── nothing left behind ─────────────────────────────────────────────────
say "checking the hosts for leftovers"
left=""
for i in "${!HOST_LINES[@]}"; do
    out=$(hssh "${i}" 'echo "containers=$(docker ps -aq --filter name=qdrill- | wc -l)"
        echo "volumes=$(docker volume ls -q --filter label=com.docker.compose.project | while read -r v; do docker volume inspect -f "{{index .Labels \"com.docker.compose.project\"}}" "$v"; done | grep -c "^qdrill-")"
        echo "rundirs=$(ls -1 "$HOME/qdrill-runs" 2>/dev/null | wc -l)"' < /dev/null 2>&1) || { left+=" host $((i + 1)): ssh failed;"; continue; }
    c=$(sed -n 's/^containers=//p' <<< "${out}"); v=$(sed -n 's/^volumes=//p' <<< "${out}"); d=$(sed -n 's/^rundirs=//p' <<< "${out}")
    [ "${c:-1}${v:-1}${d:-1}" = 000 ] || left+=" host $((i + 1)): ${c} containers, ${v} volumes, ${d} run dirs;"
done
close_masters
if [ -n "${left}" ]; then
    say "LEFT BEHIND:${left}"
    echo "LEFT BEHIND:${left}" > "${CAMPAIGN}/leftovers.txt"
    worst=2
else
    echo "clean: no drill container, volume or run dir on ${HOST_COUNT} hosts" > "${CAMPAIGN}/leftovers.txt"
fi

# ── summary.md ──────────────────────────────────────────────────────────
python3 -I "${HERE}/drill_inputs.py" campaign-summary --dir "${CAMPAIGN}" > "${CAMPAIGN}/summary.md" ||
    say "WARN: could not write summary.md"
say "campaign: ${CAMPAIGN} (summary.md); exit ${worst}"
exit "${worst}"
