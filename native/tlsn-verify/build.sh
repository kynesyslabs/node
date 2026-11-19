#!/usr/bin/env bash
# Reproducible build of the TLSNotary verifier wasm, in Docker only (no Rust
# toolchain on the host). See README.md.
#
#   ./build.sh          build, write dist/demos_tlsn_verify.wasm and its .sha256
#   ./build.sh check    build into a temp dir; fail unless it equals the
#                       committed dist/ wasm byte for byte (CI runs this)
#   ./build.sh parity   build the native twin and run it over the golden
#                       vectors; fail unless every output matches (oracle)
#
# BUILDX_BUILDER selects a buildx builder (for example a docker-container
# builder created with a memory cap); the default builder is used otherwise.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
WASM=demos_tlsn_verify.wasm
DIST="$HERE/dist"
VECTORS="$REPO/testing/tlsn-vectors"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

build_target() { # target out-dir [extra buildx args...]
    local target=$1 out=$2
    shift 2
    docker buildx build --platform linux/amd64 \
        -f "$HERE/Dockerfile" --target "$target" \
        --output "type=local,dest=$out" "$@" "$HERE"
}

case "${1:-build}" in
build)
    build_target wasm "$TMP/out"
    mkdir -p "$DIST"
    cp "$TMP/out/$WASM" "$DIST/$WASM"
    (cd "$DIST" && sha256sum "$WASM" > "$WASM.sha256")
    cat "$DIST/$WASM.sha256"
    ;;
check)
    build_target wasm "$TMP/out"
    built=$(cd "$TMP/out" && sha256sum "$WASM")
    committed=$(cat "$DIST/$WASM.sha256")
    echo "built:     $built"
    echo "committed: $committed"
    [ "$built" = "$committed" ] || { echo "FAIL: rebuilt wasm differs from dist/$WASM.sha256"; exit 1; }
    (cd "$DIST" && sha256sum -c "$WASM.sha256") || { echo "FAIL: dist/$WASM does not match its .sha256"; exit 1; }
    cmp "$TMP/out/$WASM" "$DIST/$WASM"
    echo "OK: reproducible, matches the committed wasm"
    ;;
parity)
    build_target parity "$TMP/native" --build-context "vectors=$VECTORS"
    fail=0
    for d in "$VECTORS"/*/; do
        n=$(basename "$d")
        [ -f "$d/presentation.bin" ] || continue
        native="$TMP/native/$n.json"
        if [ -f "$d/output.json" ]; then
            # Accepted vectors: the native output must equal the golden wasm
            # output byte for byte (println adds the trailing newline).
            if [ "$(cat "$native")" = "$(cat "$d/output.json")" ]; then
                echo "same     $n"
            else
                echo "DIFFERS  $n"; fail=1
            fi
        elif grep -q '"ok":false' "$native"; then
            echo "refused  $n"
        else
            echo "ACCEPTED $n (golden says refused)"; fail=1
        fi
    done
    [ "$fail" = 0 ] || { echo "FAIL: native twin disagrees with the golden vectors"; exit 1; }
    echo "OK: native twin agrees with every golden vector"
    ;;
*)
    echo "usage: $0 [build|check|parity]" >&2
    exit 2
    ;;
esac
