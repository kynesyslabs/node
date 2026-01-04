#!/usr/bin/env bash
set -e
set -u
set -o pipefail

bun install
bun pm trust --all || true
cargo install wstcp

echo "All dependencies have been installed"

