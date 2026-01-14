#!/usr/bin/env bash
set -e
set -u
set -o pipefail

# Verify prerequisites
command -v bun >/dev/null 2>&1 || { echo "Error: bun is not installed" >&2; exit 1; }
command -v cargo >/dev/null 2>&1 || { echo "Error: cargo is not installed" >&2; exit 1; }

bun install
bun pm trust --all || true

# Install wstcp only if not already present
if ! command -v wstcp >/dev/null 2>&1; then
  echo "Installing wstcp..."
  cargo install wstcp
else
  echo "wstcp already installed, skipping"
fi

echo "All dependencies have been installed"

