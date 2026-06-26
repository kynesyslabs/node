# syntax=docker/dockerfile:1.7
#
# Demos Network Node - Production Image
#
# Multistage build:
#   1. builder  - installs deps, native modules, applies falcon-sign patch
#   2. runtime  - minimal image, non-root user, healthcheck, exec CMD
#
# Run with --no-tui (passed in CMD) since TUI requires a TTY.
# All persistent state lives under /app and is intended to be bind/volume mounted:
#   - /app/.demos_identity          (file, bind-mount)
#   - /app/demos_peerlist.json      (file, bind-mount)
#   - /app/data                     (dir,  volume)
#   - /app/logs                     (dir,  volume)

# =============================================================================
# Stage 1: builder
# Installs build toolchain, resolves dependencies, compiles native modules,
# and patches falcon-sign to log uncaught exceptions before rethrowing.
# =============================================================================
FROM oven/bun:1.3-debian AS builder

# Build-time deps for native modules (bufferutil, utf-8-validate, etc.).
# python3-setuptools is required for node-gyp on newer Pythons.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        python3 \
        python3-setuptools \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy manifests first to maximise layer cache reuse on dep installs.
COPY package.json bun.lock ./

# Resolve all dependencies. Split into two RUN steps so `|| true` only
# tolerates `bun pm trust` failures (some packages have no postinstall
# script to trust), not `bun install` failures — a failed install must
# fail the build, otherwise we'd build a silently broken image.
RUN bun install --frozen-lockfile
RUN bun pm trust --all || true

# Native websocket accelerators - explicit install so they are not skipped
# when the lockfile considers them optional peers.
RUN bun add bufferutil utf-8-validate

# Bring in the runtime payload. Explicit allow-list (rather than `COPY . .`)
# so host-only files (run wrapper, captraf.sh, jest config, etc.) and any
# new top-level files added later don't silently land in the image.
COPY src/         ./src/
COPY scripts/     ./scripts/
COPY data/        ./data/
COPY sdk/         ./sdk/
COPY libs/        ./libs/
COPY tsconfig.json bunfig.toml ormconfig.json ./

# Patch falcon-sign so uncaught WASM exceptions are logged before rethrow.
# Mirrors scripts/run::patch_falcon_sign. Idempotent and tolerant of a
# missing target file (some dependency configurations omit it).
RUN set -eu; \
    FALCON_FILE="/app/node_modules/falcon-sign/kernel/n3_v1/wasmFile/falcon512.js"; \
    if [ -f "$FALCON_FILE" ]; then \
        if grep -q "console.error(ex)" "$FALCON_FILE"; then \
            echo "falcon-sign already patched"; \
        else \
            sed -i '/throw ex;/i\      console.error(ex);' "$FALCON_FILE"; \
            echo "falcon-sign patched"; \
        fi; \
    else \
        echo "falcon-sign target missing, skipping patch"; \
    fi

# Prune node_modules: remove READMEs, docs, tests, and source maps from
# transitive deps. Saves ~200-400 MB on a typical install. ARG-gated so a
# future build can opt out with --build-arg PRUNE_MODULES=false if needed.
#
# Implemented as a portable shell pass instead of pulling in node-prune so
# the build stays hermetic (no external binary download at build time).
ARG PRUNE_MODULES=true
RUN if [ "$PRUNE_MODULES" = "true" ]; then \
        echo "node_modules size before prune: $(du -sh node_modules | cut -f1)"; \
        # Documentation and license files (typical: 60-100 MB).
        # IMPORTANT: only match doc-typical extensions / extensionless files,
        # never the bare `-iname 'X*'` glob. Real packages ship runtime
        # modules whose filename happens to start with these tokens
        # (e.g. @mysten/sui/.../client/types/changes.js); deleting them
        # corrupts module resolution at runtime.
        find node_modules -type f \( \
            -iname 'README' -o -iname 'README.md' -o -iname 'README.txt' -o -iname 'README.rst' -o -iname 'README.markdown' -o \
            -iname 'CHANGELOG' -o -iname 'CHANGELOG.md' -o -iname 'CHANGELOG.txt' -o -iname 'CHANGELOG.rst' -o \
            -iname 'CHANGES' -o -iname 'CHANGES.md' -o -iname 'CHANGES.txt' -o -iname 'CHANGES.rst' -o \
            -iname 'HISTORY' -o -iname 'HISTORY.md' -o -iname 'HISTORY.txt' -o \
            -iname 'CONTRIBUTING' -o -iname 'CONTRIBUTING.md' -o -iname 'CONTRIBUTING.txt' -o \
            -iname 'AUTHORS' -o -iname 'AUTHORS.md' -o -iname 'AUTHORS.txt' -o \
            -iname 'CONTRIBUTORS' -o -iname 'CONTRIBUTORS.md' -o -iname 'CONTRIBUTORS.txt' -o \
            -iname 'LICENSE' -o -iname 'LICENSE.md' -o -iname 'LICENSE.txt' -o -iname 'LICENSE-MIT' -o -iname 'LICENSE-APACHE' -o -iname 'LICENSE-MIT.txt' -o -iname 'LICENSE-APACHE.txt' -o \
            -iname 'LICENCE' -o -iname 'LICENCE.md' -o -iname 'LICENCE.txt' -o \
            -iname 'NOTICE' -o -iname 'NOTICE.md' -o -iname 'NOTICE.txt' -o \
            -iname 'PATENTS' -o -iname 'PATENTS.md' -o -iname 'PATENTS.txt' -o \
            -iname 'governance.md' -o \
            -iname 'security.md' -o \
            -iname 'CODE_OF_CONDUCT' -o -iname 'CODE_OF_CONDUCT.md' -o -iname 'CODE_OF_CONDUCT.txt' \
        \) -delete 2>/dev/null || true; \
        # Source maps (typical: 80-150 MB)
        find node_modules -type f \( -name '*.map' -o -name '*.ts.map' \) -delete 2>/dev/null || true; \
        # Test/example directories that ship inside packages.
        # NB: bare 'test/' and 'tests/' are NOT safe to prune — some packages
        # (notably viem via @pancakeswap) use them as production module
        # namespaces (e.g. viem/actions/test/dropTransaction.js). Only prune
        # patterns that are unambiguously non-runtime.
        find node_modules -type d \( \
            -name '__tests__' -o \
            -name '__mocks__' -o \
            -name '.test' -o \
            -name 'example' -o \
            -name 'examples' -o \
            -name 'docs' -o \
            -name 'doc' \
        \) -prune -exec rm -rf {} + 2>/dev/null || true; \
        # Misc dotfiles and CI configs
        find node_modules -maxdepth 4 -type f \( \
            -name '.editorconfig' -o \
            -name '.eslintrc*' -o \
            -name '.prettierrc*' -o \
            -name '.travis.yml' -o \
            -name '.appveyor.yml' -o \
            -name '.gitattributes' -o \
            -name '.npmignore' -o \
            -name '.nvmrc' -o \
            -name '.yarnrc' -o \
            -name 'jest.config.*' -o \
            -name 'tsconfig.test.json' -o \
            -name '*.tsbuildinfo' \
        \) -delete 2>/dev/null || true; \
        echo "node_modules size after prune:  $(du -sh node_modules | cut -f1)"; \
    fi

# =============================================================================
# Stage 2: runtime
# Minimal image with only what the node needs at run time. Runs as non-root.
# =============================================================================
# ── wstcp (TLSNotary websocket↔TCP proxy) ─────────────────────────────
# The TLSNotary flow spawns `wstcp` on demand to relay the browser's
# WebSocket to the target TLS server (see proxyManager.ts). The runtime
# image ships no Rust toolchain, so the on-demand `cargo install wstcp`
# fallback in ensureWstcp() cannot run — bake the binary in instead.
# Without it the proxy never binds its port and every verification fails
# with an nginx 502 / CloseEvent 1006 on the prover.
FROM rust:1-slim AS wstcp
# Pin the version so an upstream wstcp release can't silently change
# behaviour or break the build. `--locked` is intentionally omitted: the
# crate's bundled Cargo.lock pins dependency versions that no longer
# compile on the current toolchain, so we let cargo resolve compatible
# deps for this exact wstcp version.
RUN cargo install wstcp --version 0.2.1 --root /wstcp

FROM oven/bun:1.3-debian AS runtime

# OCI image metadata.
LABEL org.opencontainers.image.source="https://github.com/kynesyslabs/node" \
      org.opencontainers.image.description="Demos Network node (RPC + consensus runtime)" \
      org.opencontainers.image.licenses="CC-BY-NC-SA-4.0" \
      org.opencontainers.image.vendor="Kynesys Labs"

# Runtime essentials only: curl for HEALTHCHECK, ca-certificates for TLS.
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Non-root user. The base image already ships a `bun` user/group at uid/gid
# 1000; rename them to `demos` in-place so the uid stays predictable for
# host bind-mount permissions and /etc/passwd reads meaningfully.
RUN groupmod --new-name demos bun \
    && usermod --login demos --home /app bun

WORKDIR /app

# Copy the built tree from the builder stage. Defense-in-depth: the
# application's source and node_modules are owned by root with no
# write permission for the demos runtime user, so a code-execution
# exploit at runtime cannot rewrite the app itself. The demos user
# only gets write access on:
#   - /app                     (entrypoint creates symlinks here)
#   - /app/data, logs, state   (volume mount points)
#
# COPY --chown bakes ownership into the same layer as the copy itself,
# avoiding a 2 GB chown layer that would otherwise duplicate the tree.
COPY --from=builder --chown=root:demos /app /app
RUN chmod 0755 /app/scripts/docker-entrypoint.sh \
    && mkdir -p /app/data /app/logs /app/state \
    && chown demos:demos /app /app/data /app/logs /app/state \
    && chmod 0755 /app /app/data /app/logs /app/state

# TLSNotary proxy binary, baked in so the on-demand proxy can spawn
# without a Rust toolchain. Lands at $HOME/.cargo/bin/wstcp (HOME=/app) —
# the exact path proxyManager.ts::ensureWstcp() probes via `test -x`.
COPY --from=wstcp --chown=demos:demos /wstcp/bin/wstcp /app/.cargo/bin/wstcp

# Build-time provenance. These ARGs are populated by the build driver
# (compose passes `git rev-parse HEAD` + `git rev-parse --abbrev-ref HEAD`
# + `git diff --quiet; echo $?` + an ISO timestamp). They land in the
# image as ENV so `process.env.GIT_COMMIT` etc. resolve from
# `src/utilities/nodeVersion.ts` without shipping `.git/` into the runtime
# layer. Missing values fall through to the module's null defaults — the
# node never panics on absence.
ARG GIT_COMMIT=
ARG GIT_BRANCH=
ARG GIT_DIRTY=false
ARG BUILT_AT=

# Sensible image-level defaults. Anything else (DATABASE_URL, EXPOSED_URL,
# IDENTITY_FILE, PEER_LIST_FILE, etc.) must be supplied at runtime.
ENV NODE_ENV=production \
    RPC_PORT=53550 \
    METRICS_HOST=0.0.0.0 \
    GIT_COMMIT=$GIT_COMMIT \
    GIT_BRANCH=$GIT_BRANCH \
    GIT_DIRTY=$GIT_DIRTY \
    BUILT_AT=$BUILT_AT

# Exposed services:
#   53550 - RPC (HTTP/JSON-RPC)
#   53551 - Omni / cross-chain bridge endpoint
#   3005  - WebRTC signaling
#   3001  - MCP server
#   9090  - Prometheus metrics
# Note: 7047 (TLSNotary) is intentionally NOT exposed - it runs in its own container.
EXPOSE 53550 53551 3005 3001 9090

# Ephemeral runtime state mount points. The entrypoint symlinks the node's
# legacy repo-root files (.demos_identity, demos_peerlist.json, .tlsnotary-key,
# output/) into /app/state so a single named volume covers all of them.
VOLUME ["/app/data", "/app/logs", "/app/state"]

USER demos

# Liveness check against the RPC /health endpoint. Returns 200 when the
# node is accepting traffic, 503 when failing (chain DB down, mainLoop
# dead). dormant/degraded states return 200 — operators read the body
# for nuance. start-period extended to 90s to cover DB connect, peer
# discovery, and chain bootstrap on cold start. Epic 13 T10 — was
# previously hitting "/" which always 200s regardless of node state.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD curl -fsS "http://localhost:${RPC_PORT:-53550}/health" >/dev/null || exit 1

# The entrypoint bridges runtime files into /app/state for persistence,
# then execs the node. --no-tui is a CMD argument (no TTY in containers).
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["bun", "-r", "tsconfig-paths/register", "src/index.ts", "--", "--no-tui"]
