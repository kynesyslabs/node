#!/bin/bash
# generate-genesis.sh — sync genesis.devnet.json's validator set to the
# freshly-generated node identities.
#
# WHY: generate-identities.sh mints fresh random mnemonics on every run, but
# the genesis validator addresses were previously hardcoded. A mismatch means
# no booted node's pubkey is in the genesis validator set, so every node hits
# NotInShardError and the chain never produces a block. This regenerates the
# `validators` array (and their genesis balances) from the current identities,
# preserving everything else in the genesis (forks, mutables, properties, ...).
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVNET_DIR="$(dirname "${SCRIPT_DIR}")"
IDENTITIES_DIR="${DEVNET_DIR}/identities"
GENESIS_FILE="${DEVNET_DIR}/genesis.devnet.json"

if [[ -f "${DEVNET_DIR}/.env" ]]; then
	source "${DEVNET_DIR}/.env"
fi

NODE_COUNT="${NODE_COUNT:-4}"
STAKE="${DEVNET_VALIDATOR_STAKE:-1000000000000000000}"

get_port() {
	local index="$1"
	local variable="NODE${index}_PORT"
	local default_port=$((53549 + (2 * index)))
	echo "${!variable:-${default_port}}"
}

echo "🧬 Syncing genesis validators to identities (count=${NODE_COUNT})..."

# Build "index pubkey port" lines for the generator.
ENTRIES=""
for i in $(seq 1 "${NODE_COUNT}"); do
	PUBKEY_FILE="${IDENTITIES_DIR}/node${i}.pubkey"
	if [[ ! -f "${PUBKEY_FILE}" ]]; then
		echo "❌ Missing identity for node${i}. Run generate-identities.sh first." >&2
		exit 1
	fi
	PUBKEY="$(cat "${PUBKEY_FILE}")"
	PORT="$(get_port "${i}")"
	ENTRIES="${ENTRIES}${i} ${PUBKEY} ${PORT}\n"
done

GENESIS_FILE="${GENESIS_FILE}" STAKE="${STAKE}" ENTRIES="$(printf "%b" "${ENTRIES}")" \
	python3 - <<'PY'
import json, os

path = os.environ["GENESIS_FILE"]
stake = os.environ["STAKE"]
entries = [l.split() for l in os.environ["ENTRIES"].splitlines() if l.strip()]

with open(path) as f:
    genesis = json.load(f)

# Rebuild validators from current identities, preserving the entry shape.
validators = []
for idx, pubkey, port in entries:
    validators.append({
        "address": pubkey,
        "status": "2",
        "connection_url": f"http://node-{idx}:{port}",
        "staked_amount": stake,
        "first_seen": 0,
        "valid_at": 0,
    })
genesis["validators"] = validators

# Ensure every validator is funded at genesis. `balances` is a list of
# [pubkey, amount] pairs. Preserve any non-validator balances already present
# that don't collide with a validator pubkey.
validator_pubkeys = {v["address"] for v in validators}
existing = genesis.get("balances") or []
preserved = [
    pair
    for pair in existing
    if isinstance(pair, list) and len(pair) == 2 and pair[0] not in validator_pubkeys
]
balances = [[v["address"], stake] for v in validators] + preserved
genesis["balances"] = balances

# Everything else (forks, mutables, properties, status, timestamp) is left
# untouched — in particular the fork activation heights.
with open(path, "w") as f:
    json.dump(genesis, f, indent=2)
    f.write("\n")

print(f"   wrote {len(validators)} validators + balances; forks preserved: "
      f"{list((genesis.get('forks') or {}).keys())}")
PY

echo "✅ Genesis validators synced to identities."
