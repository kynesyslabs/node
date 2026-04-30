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
FROM oven/bun:1.2-debian AS builder

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

# Resolve all dependencies. `bun pm trust --all` runs lifecycle scripts for
# packages that explicitly opt-in (e.g. native module postinstalls).
RUN bun install --frozen-lockfile \
    && bun pm trust --all || true

# Native websocket accelerators - explicit install so they are not skipped
# when the lockfile considers them optional peers.
RUN bun add bufferutil utf-8-validate

# Bring in the rest of the source tree.
COPY . .

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
        # Documentation and license files (typical: 60-100 MB)
        find node_modules -type f \( \
            -iname 'README*' -o \
            -iname 'CHANGELOG*' -o \
            -iname 'CHANGES*' -o \
            -iname 'HISTORY*' -o \
            -iname 'CONTRIBUTING*' -o \
            -iname 'AUTHORS*' -o \
            -iname 'CONTRIBUTORS*' -o \
            -iname 'LICEN[CS]E*' -o \
            -iname 'NOTICE*' -o \
            -iname 'NOTICES*' -o \
            -iname 'PATENTS*' -o \
            -iname 'governance.md' -o \
            -iname 'security.md' -o \
            -iname 'code_of_conduct*' \
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
FROM oven/bun:1.2-debian AS runtime

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

# Copy the built tree from the builder stage with correct ownership in one go.
COPY --from=builder --chown=demos:demos /app /app

# WORKDIR /app is owned by root by default. Hand it (and the volume mount
# points) to demos so the node can create .demos_identity, demos_peerlist.json,
# log files, and chain data on first boot. Empty named volumes that mount
# over these dirs inherit the directory ownership at first mount.
RUN chown demos:demos /app \
    && mkdir -p /app/data /app/logs /app/state \
    && chown demos:demos /app/data /app/logs /app/state

# Sensible image-level defaults. Anything else (DATABASE_URL, EXPOSED_URL,
# IDENTITY_FILE, PEER_LIST_FILE, etc.) must be supplied at runtime.
ENV NODE_ENV=production \
    RPC_PORT=53550 \
    METRICS_HOST=0.0.0.0

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

# Liveness check against the RPC HTTP root. start-period covers DB connect,
# peer discovery, and chain bootstrap which can take ~30-60s on cold start.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsS "http://localhost:${RPC_PORT:-53550}/" >/dev/null || exit 1

# The entrypoint bridges runtime files into /app/state for persistence,
# then execs the node. --no-tui is a CMD argument (no TTY in containers).
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["bun", "-r", "tsconfig-paths/register", "src/index.ts", "--", "--no-tui"]
