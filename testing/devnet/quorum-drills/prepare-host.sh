#!/usr/bin/env bash
# Prepares a fresh Ubuntu 24.04 host for multi-host quorum drills (HOSTS.md).
# Idempotent: a second run changes nothing. Run as root on the host.
#
#   prepare-host.sh --user USER [--nodes N] [--allow-from ADDR]...
#
#   --user USER        the account run.sh connects as; added to the docker group
#   --nodes N          highest node index this host may run (default 30): sizes
#                      the firewall rules
#   --allow-from ADDR  a controller or peer host address (or CIDR) the node ports
#                      are opened to with ufw; repeatable. Without it the
#                      firewall is left untouched.
set -euo pipefail

USER_NAME=""
NODES=30
ALLOW=()
while [ $# -gt 0 ]; do
    case "$1" in
        --user) USER_NAME="$2"; shift 2 ;;
        --nodes) NODES="$2"; shift 2 ;;
        --allow-from) ALLOW+=("$2"); shift 2 ;;
        -h | --help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument $1" >&2; exit 2 ;;
    esac
done
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 2; }
[ -n "${USER_NAME}" ] || { echo "--user is required" >&2; exit 2; }
id "${USER_NAME}" >/dev/null 2>&1 || { echo "no such user: ${USER_NAME}" >&2; exit 2; }
[[ "${NODES}" =~ ^[1-9][0-9]*$ ]] && [ "${NODES}" -le 400 ] || { echo "--nodes must be 1..400" >&2; exit 2; }
. /etc/os-release
[ "${ID}" = ubuntu ] && [ "${VERSION_ID}" = 24.04 ] || echo "WARNING: written for Ubuntu 24.04, this is ${PRETTY_NAME}" >&2

say() { echo "[prepare-host] $*"; }
export DEBIAN_FRONTEND=noninteractive

# ── packages ────────────────────────────────────────────────────────────
need=()
for p in ca-certificates curl gnupg jq tar rsync chrony iproute2; do
    dpkg -s "${p}" >/dev/null 2>&1 || need+=("${p}")
done
if [ "${#need[@]}" -gt 0 ]; then
    say "installing ${need[*]}"
    apt-get update -q
    apt-get install -y -q "${need[@]}"
fi
systemctl enable --now chrony >/dev/null 2>&1 || true

# Docker Engine and the compose plugin from Docker's own repository: Ubuntu's
# docker.io lags and ships compose separately
if ! dpkg -s docker-ce docker-compose-plugin >/dev/null 2>&1; then
    install -m 0755 -d /etc/apt/keyrings
    if [ ! -s /etc/apt/keyrings/docker.asc ]; then
        curl -fsSL --proto '=https' --tlsv1.2 https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
        chmod a+r /etc/apt/keyrings/docker.asc
    fi
    repo="deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable"
    if [ "$(cat /etc/apt/sources.list.d/docker.list 2>/dev/null)" != "${repo}" ]; then
        echo "${repo}" > /etc/apt/sources.list.d/docker.list
    fi
    say "installing docker-ce and the compose plugin"
    apt-get update -q
    apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

# ── docker daemon ───────────────────────────────────────────────────────
# Open-file limit for every container: each node holds a socket per peer and
# per database connection. Logging stays Docker's default (json-file, no
# rotation): the harness reads whole node logs, and rotation would cut them
daemon=/etc/docker/daemon.json
want='{"default-ulimits":{"nofile":{"Name":"nofile","Soft":1048576,"Hard":1048576}}}'
current=$(cat "${daemon}" 2>/dev/null || echo '{}')
merged=$(jq -S --argjson w "${want}" '. * $w' <<< "${current}")
if [ "$(jq -S . <<< "${current}")" != "${merged}" ]; then
    say "updating ${daemon}"
    install -m 0755 -d /etc/docker
    printf '%s\n' "${merged}" > "${daemon}.tmp" && mv "${daemon}.tmp" "${daemon}"
    systemctl restart docker
fi
systemctl enable --now docker >/dev/null 2>&1

if ! id -nG "${USER_NAME}" | tr ' ' '\n' | grep -qx docker; then
    say "adding ${USER_NAME} to the docker group (takes effect at its next login)"
    usermod -aG docker "${USER_NAME}"
fi

# ── kernel and limits ───────────────────────────────────────────────────
# Many node processes per host: inotify watchers (bun), connection backlogs,
# open files, and mmap areas (postgres)
sysctl_file=/etc/sysctl.d/90-qdrill.conf
sysctl_want='fs.inotify.max_user_instances = 8192
fs.inotify.max_user_watches = 1048576
fs.file-max = 2097152
net.core.somaxconn = 4096
net.ipv4.tcp_max_syn_backlog = 4096
vm.max_map_count = 262144'
if [ "$(cat "${sysctl_file}" 2>/dev/null)" != "${sysctl_want}" ]; then
    say "writing ${sysctl_file}"
    printf '%s\n' "${sysctl_want}" > "${sysctl_file}"
    sysctl -q --system
fi
# The node ports lie inside the default ephemeral range (32768-60999): reserve
# them, so an outgoing connection never holds a port a node is about to publish
reserved="53551-$((53549 + 2 * NODES + 1)),54550-$((54549 + NODES))"
if [ "$(sysctl -n net.ipv4.ip_local_reserved_ports)" != "${reserved}" ]; then
    printf 'net.ipv4.ip_local_reserved_ports = %s\n' "${reserved}" > /etc/sysctl.d/91-qdrill-ports.conf
    sysctl -q -p /etc/sysctl.d/91-qdrill-ports.conf
fi
limits_file=/etc/security/limits.d/90-qdrill.conf
limits_want="${USER_NAME} soft nofile 1048576
${USER_NAME} hard nofile 1048576"
if [ "$(cat "${limits_file}" 2>/dev/null)" != "${limits_want}" ]; then
    say "writing ${limits_file}"
    printf '%s\n' "${limits_want}" > "${limits_file}"
fi

# ── firewall ────────────────────────────────────────────────────────────
if [ "${#ALLOW[@]}" -gt 0 ]; then
    command -v ufw >/dev/null 2>&1 || apt-get install -y -q ufw
    ufw allow OpenSSH >/dev/null
    rpc_range="53551:$((53549 + 2 * NODES + 1))"
    gossip_range="54550:$((54549 + NODES))"
    for a in "${ALLOW[@]}"; do
        for r in "${rpc_range}" "${gossip_range}"; do
            ufw allow proto tcp from "${a}" to any port "${r}" comment qdrill >/dev/null
        done
    done
    ufw status | grep -q '^Status: active' || ufw --force enable >/dev/null
    say "ufw: tcp ${rpc_range} and ${gossip_range} open to ${ALLOW[*]}"
    # Published ports go through Docker's own iptables chains, before ufw's: a
    # port Docker publishes is reachable from anywhere whatever ufw says.
    # DOCKER-USER is where a restriction to these addresses would go.
    say "note: Docker-published ports bypass ufw; restrict them in the DOCKER-USER chain or the provider's firewall"
fi

say "docker $(docker version --format '{{.Server.Version}}'), compose $(docker compose version --short)"
say "done; ${USER_NAME} must log in again for the docker group"
