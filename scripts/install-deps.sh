#!/usr/bin/env bash
set -e
set -u
set -o pipefail

# Verify prerequisites
command -v bun >/dev/null 2>&1 || {
	echo "Error: bun is not installed" >&2
	exit 1
}

bun install --frozen-lockfile

echo "All dependencies have been installed"
