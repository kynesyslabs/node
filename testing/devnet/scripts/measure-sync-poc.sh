#!/bin/bash
set -euo pipefail

NODE_COUNT="${NODE_COUNT:-6}"
TARGET_BLOCKS="${TARGET_BLOCKS:-5}"
MAX_WAIT_SECONDS="${MAX_WAIT_SECONDS:-240}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

snapshot() {
	local destination="$1"
	: >"${destination}"
	for i in $(seq 1 "${NODE_COUNT}"); do
		docker exec "demos-devnet-node-${i}" bun -e '
const text = await (await fetch("http://127.0.0.1:9090/metrics")).text()
const lines = text.split(String.fromCharCode(10))
const value = prefix => {
    const line = lines.find(candidate => candidate.startsWith(prefix))
    return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : 0
}
console.log(JSON.stringify({
    height: value("demos_block_height "),
    blockDeliveries: value("demos_block_sync_messages_sent_total{kind=\"syncNewBlock\",source=\"post_block\"}"),
    senderStatus: value("demos_block_sync_messages_sent_total{kind=\"updateSyncData\",source=\"sender_post_block\"}"),
    receiverStatus: value("demos_block_sync_messages_sent_total{kind=\"updateSyncData\",source=\"receiver_post_block\"}"),
    aggregate: value("demos_block_sync_messages_sent_total{kind=\"updateSyncAggregate\",source=\"sender_post_block\"}"),
}))
' >>"${destination}"
	done
}

minimum_height() {
	python3 - "$1" <<'PY'
import json, sys
rows = [json.loads(line) for line in open(sys.argv[1]) if line.strip()]
print(min(row["height"] for row in rows))
PY
}

snapshot "${TMP_DIR}/start.jsonl"
START_HEIGHT="$(minimum_height "${TMP_DIR}/start.jsonl")"
DEADLINE=$((SECONDS + MAX_WAIT_SECONDS))

while true; do
	snapshot "${TMP_DIR}/current.jsonl"
	CURRENT_HEIGHT="$(minimum_height "${TMP_DIR}/current.jsonl")"
	if (( CURRENT_HEIGHT >= START_HEIGHT + TARGET_BLOCKS )); then
		break
	fi
	if (( SECONDS >= DEADLINE )); then
		echo "Timed out: minimum height moved ${START_HEIGHT} -> ${CURRENT_HEIGHT}" >&2
		exit 1
	fi
	sleep 5
done

python3 - "${TMP_DIR}/start.jsonl" "${TMP_DIR}/current.jsonl" <<'PY'
import json, sys

before = [json.loads(line) for line in open(sys.argv[1]) if line.strip()]
after = [json.loads(line) for line in open(sys.argv[2]) if line.strip()]
fields = ["blockDeliveries", "senderStatus", "receiverStatus", "aggregate"]
blocks = min(row["height"] for row in after) - min(row["height"] for row in before)
deltas = {field: sum(b[field] - a[field] for a, b in zip(before, after)) for field in fields}
deltas["totalPostBlockCalls"] = sum(deltas.values())

print(json.dumps({
    "nodes": len(before),
    "blocksObserved": blocks,
    "startHeights": [row["height"] for row in before],
    "endHeights": [row["height"] for row in after],
    "endHeightSpread": max(row["height"] for row in after) - min(row["height"] for row in after),
    "deltas": deltas,
    "callsPerBlock": {field: round(value / blocks, 3) for field, value in deltas.items()},
}, indent=2))
PY
