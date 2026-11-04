#!/usr/bin/env bash
set -e
set -u
set -o pipefail

# Add cargo to PATH
export PATH="$HOME/.cargo/bin:$PATH"

# Verify prerequisites
command -v bun >/dev/null 2>&1 || {
	echo "Error: bun is not installed" >&2
	exit 1
}
command -v cargo >/dev/null 2>&1 || {
	echo "Error: cargo is not installed" >&2
	exit 1
}

bun install --frozen-lockfile

# Same wstcp as the Docker image, so bare-metal and Docker validators
# relay TLSNotary traffic through identical code. Keep in step with the
# Dockerfile's wstcp stage and WSTCP_VERSION in proxyManager.ts.
# No --locked: the crate's bundled Cargo.lock pins time 0.3.25, which does
# not compile on Rust 1.80 or later.
WSTCP_VERSION=0.2.1
if ! cargo install --list | grep -x "wstcp v${WSTCP_VERSION}:" >/dev/null; then
	echo "Installing wstcp ${WSTCP_VERSION}..."
	cargo install wstcp --version "${WSTCP_VERSION}"
else
	echo "wstcp ${WSTCP_VERSION} already installed, skipping"
fi

echo "All dependencies have been installed"
