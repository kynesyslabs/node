#!/usr/bin/env bash
# Stub tests of multihost.sh's `docker` stand-in: which host each docker call
# of run.sh goes to, with which arguments. ssh is replaced by a script that
# runs the remote command line through sh (so the quoting is what a remote
# login shell sees) in a directory per host, where `docker` only records its
# arguments. Nothing leaves this machine.
#
#   bash testing/devnet/quorum-drills/multihost-stub.test.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK=$(mktemp -d)
trap 'rm -rf "${WORK}"' EXIT
fails=0
check() { local what="$1"; shift; if "$@"; then echo "  ok   ${what}"; else echo "  FAIL ${what}"; fails=$((fails + 1)); fi; }

mkdir -p "${WORK}/bin" "${WORK}/remote/bin" "${WORK}/h1/run" "${WORK}/h2/run" "${WORK}/run/inputs"
# ssh [-o opt]... [-p port] [-i key] [-n] [-O cmd] user@host command: runs
# command with sh in that host's dir; records `<user@host> <port>` per call
cat > "${WORK}/bin/ssh" <<'EOF'
#!/usr/bin/env bash
port=22
while [ $# -gt 0 ]; do
    case "$1" in -o | -O | -i) shift 2 ;; -p) port="$2"; shift 2 ;; -n) shift ;; *) break ;; esac
done
host="$1"; shift
echo "${host} ${port}" >> "${STUB_WORK}/ssh-ports"
case "${host}" in *@10.0.0.1) h=h1 ;; *@10.0.0.2) h=h2 ;; *) echo "unknown host ${host}" >&2; exit 255 ;; esac
cd "${STUB_WORK}/${h}" || exit 255
STUB_HOST="${h}" PATH="${STUB_WORK}/remote/bin:${PATH}" sh -c "$*"
EOF
# The remote docker: one line per call, `<host> <cwd>: arg|arg|...`; `ps` prints an id per service
cat > "${WORK}/remote/bin/docker" <<'EOF'
#!/usr/bin/env bash
line="${STUB_HOST} $(basename "$(pwd)"):"
for a in "$@"; do line+="${a}|"; done
echo "${line}" >> "${STUB_WORK}/calls"
case " $* " in
    *" ps -q "* | *" ps -aq "*)
        shift 7
        [ $# -eq 0 ] && set -- all
        for s in "$@"; do printf '%012x\n' "$(( ${#s} + ${STUB_HOST#h} * 4096 ))"; done ;;
esac
exit 0
EOF
chmod +x "${WORK}/bin/ssh" "${WORK}/remote/bin/docker"
# Host 2 listens for ssh on 2222; host 1's line has no port column (22)
printf '1\tdemos@10.0.0.1\t%s\t1,3,5\n2\tdemos@10.0.0.2\t%s\t2,4\t2222\n' "${WORK}/h1/run" "${WORK}/h2/run" > "${WORK}/map"
printf '#!/usr/bin/env bash\nsource %q && mh_docker "$@"\n' "${HERE}/multihost.sh" > "${WORK}/docker"
chmod +x "${WORK}/docker"
export STUB_WORK="${WORK}" QDRILL_MH_MAP="${WORK}/map" QDRILL_RUN_DIR="${WORK}/run" PATH="${WORK}/bin:${PATH}"
unset QDRILL_MH_HOST
D="${WORK}/docker"
calls() { cat "${WORK}/calls" 2>/dev/null; }
reset() { : > "${WORK}/calls"; }
CF="${WORK}/run/compose.yml"

echo "== compose: by service, every host for postgres or no service"
reset; "${D}" compose -f "${CF}" -p qdrill-x up -d node-1 node-2 node-5
check "node-1 and node-5 on host 1, in its run dir" grep -qxF 'h1 run:compose|-f|compose.yml|-p|qdrill-x|up|-d|node-1|node-5|' <(calls)
check "node-2 on host 2 only" grep -qxF 'h2 run:compose|-f|compose.yml|-p|qdrill-x|up|-d|node-2|' <(calls)
check "two calls" test "$(calls | wc -l)" = 2
reset; "${D}" compose -f "${CF}" -p qdrill-x stop -t 0 node-3
check "a host without the service is not called" test "$(calls)" = 'h1 run:compose|-f|compose.yml|-p|qdrill-x|stop|-t|0|node-3|'
reset; "${D}" compose -f "${CF}" -p qdrill-x up -d postgres
check "postgres: every host" test "$(calls | cut -d' ' -f1 | sort | tr '\n' ' ')" = "h1 h2 "
reset; "${D}" compose -f "${CF}" -p qdrill-x down -v --remove-orphans
check "down: every host" test "$(calls | wc -l)" = 2
reset; QDRILL_MH_HOST=2 "${D}" compose -f "${CF}" -p qdrill-x ps -q postgres > "${WORK}/out"
check "QDRILL_MH_HOST: only that host" test "$(calls)" = 'h2 run:compose|-f|compose.yml|-p|qdrill-x|ps|-q|postgres|'
check "ps output carries the host" grep -qE '^2:[0-9a-f]{12}$' "${WORK}/out"
reset; "${D}" compose -f "${CF}" -p qdrill-x ps -q > "${WORK}/out"
check "ps of everything: one id per host, prefixed" test "$(cut -d: -f1 "${WORK}/out" | tr '\n' ' ')" = "1 2 "
reset; "${D}" compose -f "${CF}" -p qdrill-x run --rm --no-deps -T --entrypoint bun node-4 -r tsconfig-paths/register ./x.ts migration:run -d ./src/model/datasource.ts
check "run: arguments after the service kept" grep -qxF 'h2 run:compose|-f|compose.yml|-p|qdrill-x|run|--rm|--no-deps|-T|--entrypoint|bun|node-4|-r|tsconfig-paths/register|./x.ts|migration:run|-d|./src/model/datasource.ts|' <(calls)

echo "== plain docker: by the host of the id, else host 1; inputs rewritten"
reset; "${D}" logs --timestamps --since 1700000000.250 2:000000001006
check "logs of a host-2 container go to host 2, prefix stripped" test "$(calls)" = 'h2 h2:logs|--timestamps|--since|1700000000.250|000000001006|'
reset; "${D}" stats --no-stream --format '{{.Name}} {{.MemUsage}}' 1:0000000000aa 2:0000000000bb 1:0000000000cc
check "ids of two hosts: one call each with its own ids" \
    bash -c 'grep -qxF "h1 h1:stats|--no-stream|--format|{{.Name}} {{.MemUsage}}|0000000000aa|0000000000cc|" "$1" && grep -qxF "h2 h2:stats|--no-stream|--format|{{.Name}} {{.MemUsage}}|0000000000bb|" "$1"' _ "${WORK}/calls"
reset; "${D}" run --rm --network none -v "${WORK}/run/inputs:/inputs:ro" img sh -c 'cat "/inputs/$1" && echo "it'"'"'s"' sh node1.identity
check "no id: host 1, RUN_DIR/inputs is the remote run dir's, quotes survive" \
    test "$(calls)" = "h1 h1:run|--rm|--network|none|-v|${WORK}/h1/run/inputs:/inputs:ro|img|sh|-c|cat \"/inputs/\$1\" && echo \"it's\"|sh|node1.identity|"
reset; QDRILL_MH_HOST=2 "${D}" exec -e "PGOPTIONS=-c statement_timeout=20000" 2:00000000beef psql -U demosuser -d node4_db -tAc 'SELECT 1'
check "exec with an id: its host, words with spaces kept" test "$(calls)" = 'h2 h2:exec|-e|PGOPTIONS=-c statement_timeout=20000|00000000beef|psql|-U|demosuser|-d|node4_db|-tAc|SELECT 1|'

echo "== ssh port from the map"
check "host 1 on 22, host 2 on 2222, nothing else" \
    test "$(sort -u "${WORK}/ssh-ports" | tr '\n' ' ')" = "demos@10.0.0.1 22 demos@10.0.0.2 2222 "

echo "== registry of an image reference"
# shellcheck source=multihost.sh
source "${HERE}/multihost.sh"
check "ghcr.io by digest" test "$(mh_registry_of ghcr.io/kynesyslabs/node:v1@sha256:abc)" = ghcr.io
check "a registry with a port" test "$(mh_registry_of registry.local:5000/x/y@sha256:abc)" = registry.local:5000
check "a Docker Hub library image" test "$(mh_registry_of postgres:16-alpine)" = docker.io
check "a Docker Hub user image" test "$(mh_registry_of nicolaka/netshoot:latest)" = docker.io

echo "== pull: skipped when present; the token only on stdin, only for a missing image"
# The remote docker for this part: host 1 has the image, host 2 does not;
# login checks the token arrives on stdin, pull that the throwaway config exists
cat > "${WORK}/remote/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "${STUB_HOST} docker $* config=${DOCKER_CONFIG:-none}" >> "${STUB_WORK}/pulls"
case "$1" in
    image) [ "${STUB_HOST}" = h1 ] ;;
    login) read -r t; [ "${t}" = "s3cret-token" ] && echo "${STUB_HOST} login stdin ok" >> "${STUB_WORK}/pulls" ;;
    pull) [ -d "${DOCKER_CONFIG:-/nonexistent}" ] ;;
esac
EOF
chmod +x "${WORK}/remote/bin/docker"
mh_load_map
IMAGE=ghcr.io/o/n@sha256:abc
REGISTRY_TOKEN=s3cret-token REGISTRY_USER=ci mh_pull 1 ghcr.io/o/n@sha256:abc > /dev/null 2>&1
REGISTRY_TOKEN=s3cret-token REGISTRY_USER=ci mh_pull 2 ghcr.io/o/n@sha256:abc > /dev/null 2>&1
check "host 1 has the image: no login, no pull" test "$(grep -c '^h1 docker \(login\|pull\)' "${WORK}/pulls")" = 0
check "host 2 logs in to ghcr.io with the token on stdin" grep -q '^h2 login stdin ok$' "${WORK}/pulls"
check "host 2 logs in as REGISTRY_USER" grep -qE '^h2 docker login ghcr.io -u ci --password-stdin config=/' "${WORK}/pulls"
check "host 2 pulls with the throwaway config" grep -qE '^h2 docker pull -q ghcr.io/o/n@sha256:abc config=/' "${WORK}/pulls"
check "the token is in no command line" bash -c '! grep -q s3cret-token "$1" "$2"' _ "${WORK}/pulls" "${WORK}/ssh-ports"
check "the throwaway config is gone after the pull" \
    bash -c 'n=0; for d in $(sed -n "s/^h2 docker pull .* config=\(.*\)$/\1/p" "$1"); do n=1; [ ! -e "$d" ] || exit 1; done; [ $n = 1 ]' _ "${WORK}/pulls"
: > "${WORK}/pulls"
mh_pull 2 ghcr.io/o/n@sha256:abc > /dev/null 2>&1
check "without REGISTRY_TOKEN: a plain pull, no login" \
    test "$(cut -d' ' -f1-4 "${WORK}/pulls" | tr '\n' '|')" = "h2 docker image inspect|h2 docker pull -q|"
: > "${WORK}/pulls"
REGISTRY_TOKEN=s3cret-token mh_pull 2 postgres:16-alpine > /dev/null 2>&1
check "an image of another registry (postgres): a plain pull, the token not sent" \
    test "$(cut -d' ' -f1-5 "${WORK}/pulls" | tr '\n' '|')" = "h2 docker image inspect postgres:16-alpine|h2 docker pull -q postgres:16-alpine|"

echo
if [ "${fails}" = 0 ]; then echo "multihost stub tests: all passed"; else echo "multihost stub tests: ${fails} FAILED"; exit 1; fi
