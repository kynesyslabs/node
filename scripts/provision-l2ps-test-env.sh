#!/usr/bin/env bash
# Provision a complete L2PS stress-test environment ON THE VPS.
#
# One command. Outputs a copy-pasteable env block that local devs paste
# into agent-commerce-demo/.env.local (or export as env vars). After
# that, ALL stress runs against this deployed node work locally with
# zero further VPS access.
#
# What it does:
#   1. Provisions an L2PS subnet on this node (data/l2ps/<uid>/) if
#      absent, otherwise reuses it.
#   2. Generates a fresh BIP-39 mnemonic for stress tests.
#   3. Funds the mnemonic from the node's .demos_identity (a
#      genesis-funded validator wallet).
#   4. Writes the env block to ./stress-env-<uid>-<ts>.txt and prints it.
#
# Run on VPS:
#   bash scripts/provision-l2ps-test-env.sh
#   L2PS_UID=stress_v2 AMOUNT=5000000000000000000 bash scripts/provision-l2ps-test-env.sh
#   PUBLIC_RPC=https://node2.demos.sh bash scripts/provision-l2ps-test-env.sh
#
# Env:
#   L2PS_UID    subnet uid (default: stress_<8hex>)
#   AMOUNT      raw units to fund the test wallet (default: 1e18)
#   FUNDER      path to funder mnemonic (default: .demos_identity)
#   RPC_URL     local RPC the script talks to (default: http://localhost:53550)
#   PUBLIC_RPC  RPC URL that local devs will use (default: $RPC_URL)
#
# After running:
#   1. Restart the node so the new subnet loads
#      → confirm: docker logs <node> | grep "Loaded L2PS: $L2PS_UID"
#   2. Securely share the printed env block (Slack DM / age / 1Password)
#   3. Locally:  paste into agent-commerce-demo/.env.local AND run stress

set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

L2PS_UID="${L2PS_UID:-stress_$(openssl rand -hex 4)}"
AMOUNT="${AMOUNT:-1000000000000000000}"
FUNDER="${FUNDER:-.demos_identity}"
RPC_URL="${RPC_URL:-http://localhost:53550}"
PUBLIC_RPC="${PUBLIC_RPC:-$RPC_URL}"

C_DIM='\033[0;90m'; C_GRN='\033[0;32m'; C_RED='\033[0;31m'; C_YLW='\033[0;33m'; C_RST='\033[0m'
log()  { printf "${C_DIM}[%s] %s${C_RST}\n" "$(date -u +%H:%M:%S)" "$*"; }
pass() { printf "${C_GRN}✔ %s${C_RST}\n" "$*"; }
fail() { printf "${C_RED}✘ %s${C_RST}\n" "$*"; }
warn() { printf "${C_YLW}⚠ %s${C_RST}\n" "$*"; }

require() { command -v "$1" >/dev/null 2>&1 || { fail "missing tool: $1"; exit 1; }; }
require openssl; require bunx; require curl; require jq

[[ -f "$FUNDER" ]] || { fail "funder mnemonic not found at $FUNDER"; exit 1; }
if ! curl -sf "$RPC_URL/info" >/dev/null; then
    fail "node not reachable at $RPC_URL — is it running?"
    exit 1
fi
pass "preflight: node up at $RPC_URL, funder=$FUNDER"

# ---------------- 1. provision L2PS subnet ------------------------------
SUBNET_DIR="data/l2ps/$L2PS_UID"
if [[ -d "$SUBNET_DIR" && -f "$SUBNET_DIR/private_key.txt" ]]; then
    log "subnet $L2PS_UID already exists — reusing existing key/iv"
else
    mkdir -p "$SUBNET_DIR"
    openssl rand -hex 32 > "$SUBNET_DIR/private_key.txt"
    openssl rand -hex 16 > "$SUBNET_DIR/iv.txt"
    chmod 600 "$SUBNET_DIR/private_key.txt" "$SUBNET_DIR/iv.txt"
    cat > "$SUBNET_DIR/config.json" <<EOF
{
    "uid": "$L2PS_UID",
    "enabled": true,
    "config": {
        "created_at_block": 0,
        "known_rpcs": ["$RPC_URL"]
    },
    "keys": {
        "private_key_path": "data/l2ps/$L2PS_UID/private_key.txt",
        "iv_path": "data/l2ps/$L2PS_UID/iv.txt"
    }
}
EOF
    pass "subnet $L2PS_UID provisioned ($SUBNET_DIR)"
fi

# ---------------- 2. generate fresh mnemonic + fund ---------------------
TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
LOG_FILE="./stress-env-${L2PS_UID}-${TS}.log"
TMPSCRIPT="$(mktemp /tmp/provision-XXXXXX.ts)"
trap 'rm -f "$TMPSCRIPT"' EXIT

cat > "$TMPSCRIPT" <<'TS'
import * as bip39 from "bip39"
import { Demos } from "@kynesyslabs/demosdk/websdk"
import { readFileSync } from "fs"

async function main() {
    const [, , rpc, funderFile, amountRaw] = process.argv
    const funderMn = readFileSync(funderFile, "utf8").trim()

    // 1. fresh mnemonic
    const testMn = bip39.generateMnemonic(256)
    const td = new Demos()
    await td.connect(rpc)
    await td.connectWallet(testMn)
    const testAddr = await td.getEd25519Address()
    console.log("TEST_MNEMONIC=" + testMn)
    console.log("TEST_ADDRESS=" + testAddr)

    // 2. fund from funder
    const fd = new Demos()
    await fd.connect(rpc)
    await fd.connectWallet(funderMn)
    const funderAddr = await fd.getEd25519Address()
    console.log("FUNDER_ADDRESS=" + funderAddr)
    const tx = await fd.pay(testAddr, BigInt(amountRaw), fd)
    const validation = await fd.confirm(tx)
    const result = await fd.broadcast(validation)
    const r = result as { result?: number; response?: { hash?: string } }
    console.log("FUND_RESULT=" + (r.result ?? "unknown"))
    console.log("FUND_TX_HASH=" + (r.response?.hash ?? (tx as { hash?: string }).hash ?? ""))
}

main().catch(e => {
    console.error("ERR:" + ((e as Error).message ?? String(e)))
    process.exit(1)
})
TS

log "generating fresh mnemonic + funding $AMOUNT raw from $FUNDER..."
bunx tsx "$TMPSCRIPT" "$RPC_URL" "$FUNDER" "$AMOUNT" 2>&1 | tee "$LOG_FILE"
fund_result=$(grep -oP 'FUND_RESULT=\K[0-9]+' "$LOG_FILE" | head -1)
test_mn=$(grep -oP 'TEST_MNEMONIC=\K.+' "$LOG_FILE" | head -1)
test_addr=$(grep -oP 'TEST_ADDRESS=\K.+' "$LOG_FILE" | head -1)
fund_tx=$(grep -oP 'FUND_TX_HASH=\K.+' "$LOG_FILE" | head -1)

if [[ -z "$test_mn" || -z "$test_addr" ]]; then
    fail "could not extract mnemonic/address — see $LOG_FILE"
    exit 2
fi
if [[ "$fund_result" != "200" ]]; then
    fail "funding tx not accepted (FUND_RESULT=$fund_result) — see $LOG_FILE"
    exit 2
fi
pass "funded $test_addr with $AMOUNT (tx $fund_tx)"

# ---------------- 3. write env block ------------------------------------
ENV_FILE="./stress-env-${L2PS_UID}-${TS}.txt"
KEY="$(cat "$SUBNET_DIR/private_key.txt")"
IV="$(cat "$SUBNET_DIR/iv.txt")"

cat > "$ENV_FILE" <<EOF
# ============================================================
# L2PS stress-test creds — generated $TS
# Paste into agent-commerce-demo/.env.local OR export as env.
# Funded address: $test_addr ($AMOUNT raw)
# ============================================================
DEMOS_RPC_URL=$PUBLIC_RPC
LIVE_DEMO_BASE_MNEMONIC="$test_mn"
LIVE_DEMO_TEST_ADDRESS=$test_addr
L2PS_UID=$L2PS_UID
L2PS_AES_KEY=$KEY
L2PS_IV=$IV
EOF
chmod 600 "$ENV_FILE"
pass "env block written to $ENV_FILE"

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  COPY THIS BLOCK INTO LOCAL  agent-commerce-demo/.env.local"
echo "═══════════════════════════════════════════════════════════════"
cat "$ENV_FILE"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "NEXT STEPS:"
echo "  1. Restart the node so the new subnet loads:"
echo "       docker compose restart node   (or your ops process)"
echo "  2. Confirm load:"
echo "       docker logs <node> 2>&1 | grep 'Loaded L2PS: $L2PS_UID'"
echo "  3. Share the env block above with whoever runs stress (secure channel)"
echo "  4. Locally:"
echo "       L2PS_UID=$L2PS_UID TARGETS=$PUBLIC_RPC \\"
echo "         scripts/l2ps-multinode-stress.sh"
