# Multi-host mode of run.sh (--hosts FILE, HOSTS.md). Function definitions
# only: run.sh sources it, and so does the `docker` stand-in it puts first on
# PATH, which sends every docker call run.sh makes to the host that runs the
# node it is about.
#
# How run.sh's single-host code keeps working unchanged:
#  - `docker compose -f RUN_DIR/compose.yml -p P <sub> [services]` runs
#    `docker compose -f compose.yml -p P <sub> [services]` in the run dir of
#    every host that holds one of the services (all hosts when none is named,
#    or postgres is: every host has its own), each host given only its own
#    services. `ps` output lines come back as `<host>:<id>`;
#  - any other docker call goes to the host of the `<host>:<id>` tokens in it
#    (prefix stripped), else to QDRILL_MH_HOST, else to host 1; RUN_DIR/inputs
#    in its arguments becomes the remote run dir's inputs;
#  - rpc, serving, psql_node and pg_limit_preflight are replaced
#    (mh_install_overrides): node RPC is read from the controller over each
#    node's public URL, and the database calls go to the node's own host.
# Host clocks must be NTP-synced: `docker logs --since` takes controller time.
#
# ssh options from the environment (exported, so the stand-in sees them too):
# QDRILL_SSH_IDENTITY a private key file, QDRILL_SSH_KNOWN_HOSTS a known_hosts
# file to use instead of ~/.ssh/known_hosts, QDRILL_SSH_ACCEPT_NEW=1 to trust
# a host key seen for the first time (rented hosts are usually new; a changed
# key is still refused).

MH_SSH_OPTS=(-o BatchMode=yes -o ControlMaster=auto -o "ControlPath=/tmp/qdrill-ssh-%C" -o ControlPersist=120
    -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
[ -n "${QDRILL_SSH_IDENTITY:-}" ] && MH_SSH_OPTS+=(-i "${QDRILL_SSH_IDENTITY}" -o IdentitiesOnly=yes)
[ -n "${QDRILL_SSH_KNOWN_HOSTS:-}" ] && MH_SSH_OPTS+=(-o "UserKnownHostsFile=${QDRILL_SSH_KNOWN_HOSTS}")
[ "${QDRILL_SSH_ACCEPT_NEW:-0}" = 1 ] && MH_SSH_OPTS+=(-o StrictHostKeyChecking=accept-new)

# One POSIX single-quoted word per argument: the remote login shell may be sh
mh_q() { local a; for a in "$@"; do printf "'%s' " "${a//\'/\'\\\'\'}"; done; }

# Map file (QDRILL_MH_MAP), one host per line: index, user@ip, remote run dir,
# nodes (csv), ssh port (22 when the column is missing)
mh_load_map() {
    local k ssh dir nodes port i
    MH_KS=(); MH_SSH=(); MH_DIR=(); MH_PORT=(); MH_HOST_OF=()
    [ -r "${QDRILL_MH_MAP:-}" ] || { echo "multihost: no host map (QDRILL_MH_MAP=${QDRILL_MH_MAP:-})" >&2; return 1; }
    while IFS=$'\t' read -r k ssh dir nodes port; do
        [ -n "${k}" ] || continue
        MH_KS+=("${k}"); MH_SSH[k]="${ssh}"; MH_DIR[k]="${dir}"; MH_PORT[k]="${port:-22}"
        for i in ${nodes//,/ }; do MH_HOST_OF[i]="${k}"; done
    done < "${QDRILL_MH_MAP}"
    [ "${#MH_KS[@]}" -gt 0 ]
}

mh_ssh() { # $1 host index, [-n: no stdin], then the remote command line (already quoted)
    local k="$1" o=(); shift
    [ "${1:-}" = -n ] && { o=(-n); shift; }
    ssh "${MH_SSH_OPTS[@]}" -p "${MH_PORT[k]:-22}" "${o[@]}" "${MH_SSH[k]}" "$@"
}

# The registry of an image reference: its first path component when that
# looks like a host (has a dot or a port, or is localhost), else Docker Hub
mh_registry_of() {
    local first="${1%%/*}"
    if [ "${first}" != "$1" ] && { [[ "${first}" == *.* ]] || [[ "${first}" == *:* ]] || [ "${first}" = localhost ]; }; then
        echo "${first}"
    else
        echo docker.io
    fi
}

# Pulls $2 on host $1 unless it is already there (the reference is by
# digest, so a present image is the same bytes). With REGISTRY_TOKEN set the
# pull logs in first, into a throwaway DOCKER_CONFIG that is removed when the
# pull ends: the token travels on ssh's stdin, never in a command line, and no
# credential stays on the host.
mh_pull() {
    local k="$1" img="$2" reg
    mh_ssh "${k}" -n "docker image inspect $(mh_q "${img}") >/dev/null 2>&1" && { echo "host ${k}: ${img} already present"; return 0; }
    if [ -z "${REGISTRY_TOKEN:-}" ]; then
        mh_ssh "${k}" -n "docker pull -q $(mh_q "${img}")"
        return
    fi
    reg=$(mh_registry_of "${img}")
    printf '%s\n' "${REGISTRY_TOKEN}" | mh_ssh "${k}" "d=\$(mktemp -d) || exit 1
        trap 'rm -rf \"\$d\"' EXIT
        DOCKER_CONFIG=\"\$d\" docker login $(mh_q "${reg}") -u $(mh_q "${REGISTRY_USER:-token}") --password-stdin >/dev/null &&
            DOCKER_CONFIG=\"\$d\" docker pull -q $(mh_q "${img}")"
}

# The `docker` stand-in
mh_docker() {
    mh_load_map || return 125
    if [ "${1:-}" = compose ]; then shift; mh_docker_compose "$@"; else mh_docker_plain "$@"; fi
}

mh_docker_compose() {
    local proj="" sub="" k t keep any_node=0 all=0 rc=0 out
    local -a rest targets args pids
    local -A want
    while [ $# -gt 0 ]; do
        case "$1" in
            -f | --file) shift 2 ;;
            -p | --project-name) proj="$2"; shift 2 ;;
            *) sub="$1"; shift; break ;;
        esac
    done
    rest=("$@")
    for t in "${rest[@]}"; do
        case "${t}" in
            postgres) all=1 ;;
            node-*) [[ "${t}" =~ ^node-([0-9]+)$ ]] && { any_node=1; want[${MH_HOST_OF[${BASH_REMATCH[1]}]:-0}]=1; } ;;
        esac
    done
    if [ -n "${QDRILL_MH_HOST:-}" ]; then targets=("${QDRILL_MH_HOST}")
    elif [ "${any_node}" = 0 ] || [ "${all}" = 1 ]; then targets=("${MH_KS[@]}")
    else targets=(); for k in "${MH_KS[@]}"; do [ -n "${want[${k}]:-}" ] && targets+=("${k}"); done
    fi
    out=$(mktemp -d) || return 125
    trap 'kill $(jobs -p) 2>/dev/null; rm -rf "${out}"; exit 143' TERM INT
    pids=()
    for k in "${targets[@]}"; do
        args=(); keep=0
        for t in "${rest[@]}"; do
            if [[ "${t}" =~ ^node-([0-9]+)$ ]]; then
                [ "${MH_HOST_OF[${BASH_REMATCH[1]}]:-0}" = "${k}" ] || continue
                keep=1
            fi
            args+=("${t}")
        done
        [ "${any_node}" = 1 ] && [ "${keep}" = 0 ] && [ "${all}" = 0 ] && continue
        mh_ssh "${k}" -n "cd $(mh_q "${MH_DIR[k]}") && docker compose -f compose.yml -p $(mh_q "${proj}") $(mh_q "${sub}" "${args[@]}")" \
            > "${out}/${k}" &
        pids+=("$!:${k}")
    done
    for t in "${pids[@]}"; do
        wait "${t%%:*}" || rc=$?
        k="${t#*:}"
        if [ "${sub}" = ps ]; then sed "/^\$/d; s/^/${k}:/" "${out}/${k}"; else cat "${out}/${k}"; fi
    done
    rm -rf "${out}"
    return "${rc}"
}

mh_docker_plain() {
    local t k rc=0 stdin=-n
    local -a args targets
    local -A want
    for t in "$@"; do
        [[ "${t}" =~ ^([0-9]+):[0-9a-f]{12,64}$ ]] && want[${BASH_REMATCH[1]}]=1
        [ "${t}" = -i ] && stdin=""
    done
    if [ "${#want[@]}" -gt 0 ]; then targets=("${!want[@]}")
    else targets=("${QDRILL_MH_HOST:-${MH_KS[0]}}")
    fi
    for k in "${targets[@]}"; do
        args=()
        for t in "$@"; do
            if [[ "${t}" =~ ^([0-9]+):([0-9a-f]{12,64})$ ]]; then
                [ "${BASH_REMATCH[1]}" = "${k}" ] && args+=("${BASH_REMATCH[2]}")
                continue
            fi
            args+=("${t//${QDRILL_RUN_DIR}\/inputs/${MH_DIR[k]}/inputs}")
        done
        # shellcheck disable=SC2086 # stdin is -n or nothing
        mh_ssh "${k}" ${stdin} "docker $(mh_q "${args[@]}")" || rc=$?
    done
    return "${rc}"
}

# ── run.sh side ─────────────────────────────────────────────────────────

# Reads the hosts file into the plan (drill_inputs.py hosts) and writes the
# docker stand-in. Exits 2 on a bad file.
mh_init() {
    local line k ssh ip max nodes port
    MH_PLAN=$(python3 -I "${HERE}/drill_inputs.py" hosts --file "${HOSTS_FILE}" --nodes "${N}" 2>&1) ||
        { echo "--hosts ${HOSTS_FILE}: ${MH_PLAN}" >&2; exit 2; }
    MH_KS=(); MH_SSH=(); MH_IP=(); MH_NODES=(); MH_PORT=(); MH_HOST_OF=()
    while IFS=$'\t' read -r k ssh ip max nodes port; do
        MH_KS+=("${k}"); MH_SSH[k]="${ssh}"; MH_IP[k]="${ip}"; MH_NODES[k]="${nodes}"; MH_PORT[k]="${port:-22}"
        for line in ${nodes//,/ }; do MH_HOST_OF[line]="${k}"; done
    done <<< "${MH_PLAN}"
    mkdir -p "${RUN_DIR}/mhbin"
    printf '#!/usr/bin/env bash\nsource %q && mh_docker "$@"\n' "${HERE}/multihost.sh" > "${RUN_DIR}/mhbin/docker"
    chmod 755 "${RUN_DIR}/mhbin/docker"
    export QDRILL_RUN_DIR="${RUN_DIR}" QDRILL_MH_MAP="${RUN_DIR}/hosts.map"
    MH_DIRS_MADE=()
}

# Plain HTTP because the node serves its RPC port without TLS (validators sit
# behind an operator's proxy for that); the URL is the one in the drill's
# genesis and EXPOSED_URL, on hosts HOSTS.md restricts to the drill's addresses
mh_url() { echo "http://${MH_IP[${MH_HOST_OF[$1]}]}:$(port_of "$1")"; }
mh_nodes_on() { local n="${MH_NODES[$1]}"; echo "${n//,/ }" | wc -w; }

mh_kv() { sed -n "s/^$1=//p" <<< "${out}" | head -1; } # $1 key of mh_preflight's probe output

# Per host: ssh, docker and compose, disk, RAM for its nodes, load, swap, no
# other harness stack, then the image (by digest) and postgres pulled, and the
# run dir made (0700). Every failure ends the run through abort_pre.
mh_preflight() {
    local k out need disk avail cores load swapping harness home dver cver
    for k in "${MH_KS[@]}"; do
        out=$(mh_ssh "${k}" -n 'echo "home=$HOME"
            echo "disk=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)"
            echo "avail=$(free -m | awk "/^Mem:/{print \$7}")"
            echo "cores=$(nproc)"
            echo "load=$(cut -d" " -f1 /proc/loadavg)"
            echo "swapping=$(vmstat 1 4 | tail -3 | awk "\$7 + \$8 > 0 {n++} END {print (n == 3) ? 1 : 0}")"
            echo "dver=$(docker version --format "{{.Server.Version}}" 2>/dev/null)"
            echo "cver=$(docker compose version --short 2>/dev/null)"
            echo "harness=$(docker ps --format "{{.Names}}" 2>/dev/null | grep -cE "^(crace|qdrill)-")"' 2>&1) ||
            abort_pre "host ${k} (${MH_SSH[k]}): ssh failed: $(tail -1 <<< "${out}")"
        echo "host ${k} ${MH_SSH[k]}: ${out//$'\n'/ }" >> "${STEP_LOG}"
        home=$(mh_kv home); disk=$(mh_kv disk); avail=$(mh_kv avail); cores=$(mh_kv cores); load=$(mh_kv load)
        swapping=$(mh_kv swapping); dver=$(mh_kv dver); cver=$(mh_kv cver); harness=$(mh_kv harness)
        need=$(( $(mh_nodes_on "${k}") * NODE_EST_MB + HEADROOM_MB ))
        say "host ${k} ${MH_SSH[k]}: nodes ${MH_NODES[k]}; disk ${disk}G, ${avail}M RAM available (need ${need}M), load ${load}/${cores}, swapping=${swapping}, docker ${dver:-none}, compose ${cver:-none}"
        [[ "${home}" == /* ]] || abort_pre "host ${k}: no home directory"
        [ -n "${dver}" ] || abort_pre "host ${k}: docker is not usable by ${MH_SSH[k]} (prepare-host.sh, then log in again)"
        [ -n "${cver}" ] || abort_pre "host ${k}: no docker compose plugin"
        [ "${disk:-0}" -lt "${MIN_DISK_GB}" ] && abort_pre "host ${k}: free disk ${disk}G < ${MIN_DISK_GB}G"
        [ "${avail:-0}" -lt "${need}" ] && abort_pre "host ${k}: available RAM ${avail}M < ${need}M needed for $(mh_nodes_on "${k}") nodes (${NODE_EST_MB}M each incl. postgres + ${HEADROOM_MB}M headroom)"
        awk -v l="${load}" -v m="${cores}" 'BEGIN { exit !(l > m) }' && abort_pre "host ${k}: load ${load} > ${cores} cores"
        [ "${swapping}" = 1 ] && abort_pre "host ${k}: actively swapping"
        [ "${harness:-0}" = 0 ] || abort_pre "host ${k}: another harness stack is running"
        MH_DIR[k]="${home}/qdrill-runs/${RUN_ID}"
    done
    say "pulling ${IMAGE} and postgres:16-alpine on ${#MH_KS[@]} hosts$([ -n "${REGISTRY_TOKEN:-}" ] && echo " (registry login from REGISTRY_TOKEN)")"
    local -a pids=()
    for k in "${MH_KS[@]}"; do
        { mh_pull "${k}" "${IMAGE}" && mh_pull "${k}" postgres:16-alpine; } >> "${STEP_LOG}" 2>&1 &
        pids+=("$!")
    done
    for k in "${!pids[@]}"; do wait "${pids[k]}" || abort_pre "host ${MH_KS[k]}: docker pull of ${IMAGE} or postgres:16-alpine failed (see 01-preflight.log)"; done
    : > "${QDRILL_MH_MAP}"
    for k in "${MH_KS[@]}"; do
        mh_ssh "${k}" -n "umask 077 && mkdir -p $(mh_q "${MH_DIR[k]}") && chmod 700 \"\$HOME/qdrill-runs\" $(mh_q "${MH_DIR[k]}")" >> "${STEP_LOG}" 2>&1 ||
            abort_pre "host ${k}: could not make ${MH_DIR[k]}"
        MH_DIRS_MADE+=("${k}")
        printf '%s\t%s\t%s\t%s\t%s\n' "${k}" "${MH_SSH[k]}" "${MH_DIR[k]}" "${MH_NODES[k]}" "${MH_PORT[k]}" >> "${QDRILL_MH_MAP}"
    done
    export PATH="${RUN_DIR}/mhbin:${PATH}"
}

# Copies hosts/<k>/ (gen-inputs.py) into each host's run dir; the dir stays 0700
mh_push_inputs() {
    local k
    for k in "${MH_KS[@]}"; do
        tar -C "${RUN_DIR}/hosts/${k}" -cf - . |
            mh_ssh "${k}" "tar -C $(mh_q "${MH_DIR[k]}") -xpf - && chmod 700 $(mh_q "${MH_DIR[k]}")" || return 1
    done
}

# Replaces the single-host readers (see the top of this file)
mh_install_overrides() {
    rpc() { # $1 node, $2 JSON body, $3 curl timeout in s (default 4)
        curl -sS -m"${3:-4}" -X POST -H 'Content-Type: application/json' -d "$2" "$(mh_url "$1")/" 2>/dev/null
    }
    serving() { curl -sS -m3 "$(mh_url "$1")/" 2>/dev/null | grep -q Hello; }
    eval "mh_single_psql_node() $(declare -f psql_node | tail -n +2)"
    psql_node() { local QDRILL_MH_HOST; export QDRILL_MH_HOST="${MH_HOST_OF[$1]}"; mh_single_psql_node "$@"; }
    eval "mh_single_pg_limit_preflight() $(declare -f pg_limit_preflight | tail -n +2)"
    # Each host's postgres serves only its own nodes
    pg_limit_preflight() {
        local k QDRILL_MH_HOST N
        for k in "${MH_KS[@]}"; do
            export QDRILL_MH_HOST="${k}"; N=$(mh_nodes_on "${k}")
            say "host ${k}:"
            mh_single_pg_limit_preflight || return 1
        done
    }
}

# tc netem on each host's bridge of this run's network: every packet a host
# routes into its containers (from the other hosts and from the controller)
# is delayed there. Containers on one host talk over the bridge directly and
# are not. Skipped, with a warning, on a host without root or passwordless sudo.
MH_NETEM_ON=()
mh_netem_apply() {
    local k br out
    for k in "${MH_KS[@]}"; do
        out=$(mh_ssh "${k}" -n "id=\$(docker network inspect -f '{{.Id}}' $(mh_q "${PROJECT}_drillnet")) || exit 4
            br=br-\$(printf %.12s \"\${id}\")
            if [ \"\$(id -u)\" = 0 ]; then s=''; elif sudo -n true 2>/dev/null; then s='sudo -n'; else echo nosudo; exit 3; fi
            \${s} tc qdisc replace dev \"\${br}\" root netem ${NETEM} && echo \"\${br}\"" 2>&1)
        case $? in
            0) br=$(tail -1 <<< "${out}"); MH_NETEM_ON[k]="${br}"; say "host ${k}: netem '${NETEM}' on ${br}" ;;
            3) say "WARNING: host ${k}: no root or passwordless sudo, netem not applied there" ;;
            *) say "WARNING: host ${k}: netem not applied: $(tail -1 <<< "${out}")" ;;
        esac
    done
}
mh_netem_clear() {
    local k
    for k in "${!MH_NETEM_ON[@]}"; do
        mh_ssh "${k}" -n "if [ \"\$(id -u)\" = 0 ]; then s=''; else s='sudo -n'; fi; \${s} tc qdisc del dev $(mh_q "${MH_NETEM_ON[k]}") root" \
            >> "${LOG_DIR}/teardown.log" 2>&1 || true
    done
    MH_NETEM_ON=()
}

# Removes each host's run dir (its devnet keys); what a container left there
# owned by root goes through a throwaway container. Then closes the ssh masters.
mh_cleanup_dirs() {
    local k d
    for k in "${MH_DIRS_MADE[@]}"; do
        d="${MH_DIR[k]}"
        case "${d}" in */qdrill-runs/"${RUN_ID}") ;; *) continue ;; esac
        mh_ssh "${k}" -n "rm -rf $(mh_q "${d}") 2>/dev/null ||
            { docker run --rm --network none -v $(mh_q "${d}"):/d --entrypoint sh postgres:16-alpine -c 'rm -rf /d/* /d/.[!.]*' && rm -rf $(mh_q "${d}"); }" \
            >> "${LOG_DIR}/teardown.log" 2>&1 || say "WARNING: host ${k}: could not remove ${d}"
    done
    MH_DIRS_MADE=()
    for k in "${MH_KS[@]}"; do ssh "${MH_SSH_OPTS[@]}" -p "${MH_PORT[k]:-22}" -O exit "${MH_SSH[k]}" >/dev/null 2>&1 || true; done
}
