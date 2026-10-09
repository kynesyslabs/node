#!/usr/bin/env bash
# DACS RFQ over L2PS messaging, end to end: one command, its own Postgres and
# node, torn down on exit.
#
#   ./testing/l2ps-messaging/e2e.sh
#
# Runs this tree's node natively (bun) with messaging on and two throwaway
# subnets, then drives it with the SDK the node depends on
# (testing/l2ps-messaging/rfq-e2e.ts).
#
# LOG_DIR   where the run's logs are kept (default /tmp/l2ps-rfq-e2e-<time>)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${LOG_DIR:-/tmp/l2ps-rfq-e2e-$(date +%Y%m%dT%H%M%S)}"
mkdir -p "$LOG_DIR"
RUN_ID="$(date +%s)$$"
PG_CONTAINER="l2ps-rfq-e2e-pg-$RUN_ID"
SUBNET_A="rfq_e2e_a_$RUN_ID"
SUBNET_B="rfq_e2e_b_$RUN_ID"
WORK="$(mktemp -d)"
NODE_PID=""

free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }
PG_PORT="$(free_port)"
RPC_PORT="$(free_port)"
MSG_PORT="$(free_port)"
SIG_PORT="$(free_port)"

step() { printf '\n[e2e] %s\n' "$*" | tee -a "$LOG_DIR/e2e.log"; }

# The node writes a few files into its working directory at boot; remove only
# the ones this run created.
before="$(cd "$ROOT" && ls -1A)"

cleanup() {
    step "tearing down"
    if [ -n "$NODE_PID" ] && kill -0 "$NODE_PID" 2>/dev/null; then
        kill "$NODE_PID" 2>/dev/null || true
        for _ in $(seq 1 20); do kill -0 "$NODE_PID" 2>/dev/null || break; sleep 0.5; done
        kill -9 "$NODE_PID" 2>/dev/null || true
    fi
    docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
    rm -rf "$ROOT/data/l2ps/$SUBNET_A" "$ROOT/data/l2ps/$SUBNET_B" "$WORK"
    comm -13 <(echo "$before" | sort) <(cd "$ROOT" && ls -1A | sort) | while read -r f; do
        case "$f" in
            publickey_*|logs_*) rm -rf "${ROOT:?}/$f" ;;
        esac
    done
    echo "logs: $LOG_DIR"
}
trap cleanup EXIT

step "postgres on :$PG_PORT (tmpfs)"
docker run -d --rm --name "$PG_CONTAINER" --memory 1g --tmpfs /var/lib/postgresql/data \
    -p "127.0.0.1:$PG_PORT:5432" -e POSTGRES_USER=demosuser -e POSTGRES_PASSWORD=e2e -e POSTGRES_DB=demos \
    postgres:16-alpine >>"$LOG_DIR/e2e.log"
for _ in $(seq 1 60); do docker exec "$PG_CONTAINER" pg_isready -U demosuser >/dev/null 2>&1 && break; sleep 1; done

step "subnets $SUBNET_A, $SUBNET_B"
for uid in "$SUBNET_A" "$SUBNET_B"; do
    dir="$ROOT/data/l2ps/$uid"
    mkdir -p "$dir"
    openssl rand -hex 32 >"$dir/private_key.txt"
    openssl rand -hex 16 >"$dir/iv.txt"
    cat >"$dir/config.json" <<EOF
{ "uid": "$uid", "enabled": true,
  "config": { "created_at_block": 0, "known_rpcs": ["http://127.0.0.1:$RPC_PORT"] },
  "keys": { "private_key_path": "data/l2ps/$uid/private_key.txt", "iv_path": "data/l2ps/$uid/iv.txt" } }
EOF
done

step "node: rpc :$RPC_PORT, messaging :$MSG_PORT"
# Explicit environment wins over any developer .env (dotenv does not override).
(
    cd "$ROOT"
    export IDENTITY_FILE="$WORK/identity" RPC_PORT EXPOSED_URL="http://127.0.0.1:$RPC_PORT" \
        OMNI_ENABLED=false RPC_SIGNALING_PORT="$SIG_PORT" MCP_ENABLED=false METRICS_ENABLED=false \
        TLSNOTARY_ENABLED=false L2PS_ZK_ENABLED=false PROD=false \
        PG_HOST=127.0.0.1 PG_PORT PG_USER=demosuser PG_PASSWORD=e2e PG_DATABASE=demos \
        L2PS_MESSAGING_ENABLED=true L2PS_MESSAGING_PORT="$MSG_PORT"
    exec bun -r tsconfig-paths/register src/index.ts --no-tui
) >"$LOG_DIR/node.log" 2>&1 &
NODE_PID=$!

for _ in $(seq 1 120); do
    if ! kill -0 "$NODE_PID" 2>/dev/null; then
        echo "node exited during startup; see $LOG_DIR/node.log" | tee -a "$LOG_DIR/e2e.log"
        tail -20 "$LOG_DIR/node.log"
        exit 1
    fi
    if curl -s -o /dev/null "http://127.0.0.1:$MSG_PORT/" && curl -sf -o /dev/null "http://127.0.0.1:$RPC_PORT/version"; then
        break
    fi
    sleep 1
done

step "scenario"
cd "$ROOT"
NODE_RPC="http://127.0.0.1:$RPC_PORT" MESSAGING_WS="ws://127.0.0.1:$MSG_PORT" \
    SUBNET_A="$SUBNET_A" SUBNET_B="$SUBNET_B" SUBNET_KEY_DIR="$ROOT/data/l2ps" \
    bun testing/l2ps-messaging/rfq-e2e.ts 2>&1 | tee "$LOG_DIR/scenario.log"
exit "${PIPESTATUS[0]}"
