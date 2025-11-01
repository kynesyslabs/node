#!/usr/bin/env bash
# Simple helper to capture consensus_routine HTTP responses from a local node.
# Usage:
#   NODE_URL=http://127.0.0.1:53550 ./omniprotocol_fixtures_scripts/capture_consensus.sh getCommonValidatorSeed
#   ./omniprotocol_fixtures_scripts/capture_consensus.sh getValidatorTimestamp --blockRef 123 --outfile fixtures/consensus/getValidatorTimestamp.json
#
# The script writes the raw JSON response to the requested outfile (defaults to fixtures/consensus/<method>.json)
# and pretty-prints it if jq is available.

set -euo pipefail

NODE_URL=${NODE_URL:-http://127.0.0.1:53550}
OUT_DIR=${OUT_DIR:-fixtures/consensus}
mkdir -p "$OUT_DIR"

if [[ $# -lt 1 ]]; then
    echo "Usage: NODE_URL=http://... $0 <method> [--blockRef <n>] [--timestamp <n>] [--phase <n>] [--outfile <path>]" >&2
    echo "Supported read-only methods: getCommonValidatorSeed, getValidatorTimestamp, getBlockTimestamp" >&2
    echo "Interactive methods (require additional params): proposeBlockHash, setValidatorPhase, greenlight" >&2
    exit 1
fi

METHOD="$1"
shift

BLOCK_REF=""
TIMESTAMP=""
PHASE=""
BLOCK_HASH=""
VALIDATION_DATA=""
PROPOSER=""
OUTFILE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --blockRef)
            BLOCK_REF="$2"
            shift 2
            ;;
        --timestamp)
            TIMESTAMP="$2"
            shift 2
            ;;
        --phase)
            PHASE="$2"
            shift 2
            ;;
        --blockHash)
            BLOCK_HASH="$2"
            shift 2
            ;;
        --validationData)
            VALIDATION_DATA="$2"
            shift 2
            ;;
        --proposer)
            PROPOSER="$2"
            shift 2
            ;;
        --outfile)
            OUTFILE="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

if [[ -z "$OUTFILE" ]]; then
    OUTFILE="$OUT_DIR/${METHOD}.json"
fi

build_payload() {
    case "$METHOD" in
        getCommonValidatorSeed|getValidatorTimestamp|getBlockTimestamp)
            printf '{"method":"consensus_routine","params":[{"method":"%s","params":[]}]}' "$METHOD"
            ;;
        proposeBlockHash)
            if [[ -z "$BLOCK_HASH" || -z "$VALIDATION_DATA" || -z "$PROPOSER" ]]; then
                echo "proposeBlockHash requires --blockHash, --validationData, and --proposer" >&2
                exit 1
            fi
            printf '{"method":"consensus_routine","params":[{"method":"proposeBlockHash","params":["%s",%s,"%s"]}]}' \
                "$BLOCK_HASH" "$VALIDATION_DATA" "$PROPOSER"
            ;;
        setValidatorPhase)
            if [[ -z "$PHASE" || -z "$BLOCK_REF" ]]; then
                echo "setValidatorPhase requires --phase and --blockRef" >&2
                exit 1
            fi
            printf '{"method":"consensus_routine","params":[{"method":"setValidatorPhase","params":[%s,null,%s]}]}' \
                "$PHASE" "$BLOCK_REF"
            ;;
        greenlight)
            if [[ -z "$BLOCK_REF" || -z "$TIMESTAMP" || -z "$PHASE" ]]; then
                echo "greenlight requires --blockRef, --timestamp, and --phase" >&2
                exit 1
            fi
            printf '{"method":"consensus_routine","params":[{"method":"greenlight","params":[%s,%s,%s]}]}' \
                "$BLOCK_REF" "$TIMESTAMP" "$PHASE"
            ;;
        *)
            echo "Unsupported method: $METHOD" >&2
            exit 1
            ;;
    esac
}

PAYLOAD="$(build_payload)"

echo "[capture_consensus] Sending ${METHOD} to ${NODE_URL}"
curl -sS -H "Content-Type: application/json" -d "$PAYLOAD" "$NODE_URL" | tee "$OUTFILE" >/dev/null

if command -v jq >/dev/null 2>&1; then
    echo "[capture_consensus] Response (pretty):"
    jq . "$OUTFILE"
else
    echo "[capture_consensus] jq not found, raw response saved to $OUTFILE"
fi
