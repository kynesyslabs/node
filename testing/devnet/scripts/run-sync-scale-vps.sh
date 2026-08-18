#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NODE_COUNTS="${NODE_COUNTS:-100,250,500}"
ITERATIONS="${ITERATIONS:-5}"
AGGREGATE_VERSION="${AGGREGATE_VERSION:-2}"
MIN_AVAILABLE_KIB="${MIN_AVAILABLE_KIB:-2097152}"
RESULTS_DIR="${RESULTS_DIR:-${ROOT_DIR}/.poc-results}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT_PATH="${RESULTS_DIR}/sync-scale-${TIMESTAMP}.json"
POC_NODES=(
	demos-devnet-node-1
	demos-devnet-node-2
	demos-devnet-node-3
	demos-devnet-node-4
	demos-devnet-node-5
	demos-devnet-node-6
)
DACS_SERVICES=(dacs-gateway dacs-oracle dacs-dd dacs-auditor)
PAUSED_NODES=()

resume_nodes() {
	for container in "${PAUSED_NODES[@]}"; do
		docker unpause "${container}" >/dev/null 2>&1 || true
	done
}
trap resume_nodes EXIT INT TERM

for service in "${DACS_SERVICES[@]}"; do
	if [[ "$(systemctl is-active "${service}")" != "active" ]]; then
		echo "Refusing scale test: ${service} is not active" >&2
		exit 1
	fi
done

for container in "${POC_NODES[@]}"; do
	if [[ "$(docker inspect -f '{{.State.Running}}' "${container}" 2>/dev/null || true)" == "true" ]]; then
		docker pause "${container}" >/dev/null
		PAUSED_NODES+=("${container}")
	fi
done

AVAILABLE_KIB="$(awk '/MemAvailable:/ { print $2 }' /proc/meminfo)"
if (( AVAILABLE_KIB < MIN_AVAILABLE_KIB )); then
	echo "Refusing scale test: only ${AVAILABLE_KIB} KiB memory available" >&2
	exit 1
fi

mkdir -p "${RESULTS_DIR}"
echo "Running bounded sync emulator: nodes=${NODE_COUNTS} iterations=${ITERATIONS} aggregate-version=${AGGREGATE_VERSION}" >&2
echo "Six-node POC paused=${#PAUSED_NODES[@]}; live DACS remains active" >&2

cd "${ROOT_DIR}"
bun testing/devnet/scripts/run-sync-scale-emulator.ts \
	--nodes="${NODE_COUNTS}" \
	--iterations="${ITERATIONS}" \
	--aggregate-version="${AGGREGATE_VERSION}" >"${REPORT_PATH}" &
EMULATOR_PID=$!

while kill -0 "${EMULATOR_PID}" 2>/dev/null; do
	AVAILABLE_KIB="$(awk '/MemAvailable:/ { print $2 }' /proc/meminfo)"
	if (( AVAILABLE_KIB < MIN_AVAILABLE_KIB )); then
		echo "Aborting scale test: memory guard crossed" >&2
		kill "${EMULATOR_PID}" 2>/dev/null || true
		wait "${EMULATOR_PID}" || true
		exit 1
	fi
	sleep 1
done

wait "${EMULATOR_PID}"

for service in "${DACS_SERVICES[@]}"; do
	if [[ "$(systemctl is-active "${service}")" != "active" ]]; then
		echo "Scale test completed but ${service} is not active" >&2
		exit 1
	fi
done

resume_nodes
PAUSED_NODES=()
POC_PORTS=(53551 53553 53555 53557 53559 53561)
for attempt in $(seq 1 12); do
	READY=0
	for port in "${POC_PORTS[@]}"; do
		if curl -fsS --max-time 2 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
			READY=$((READY + 1))
		fi
	done
	if (( READY == ${#POC_PORTS[@]} )); then
		break
	fi
	sleep 5
done
if (( READY != ${#POC_PORTS[@]} )); then
	echo "Scale test passed, but only ${READY}/${#POC_PORTS[@]} POC nodes recovered" >&2
	exit 1
fi

echo "SYNC_SCALE_REPORT=${REPORT_PATH}"
