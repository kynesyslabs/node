# Demos Network Devnet Node
FROM oven/bun:1.4.4-debian@sha256:93d5032fe06d163427822dc1598f420363759bb18155c9cc90eb1be05a64a19e

# No compiler: lifecycle scripts are blocked and the native modules the
# node uses ship prebuilt binaries.
# Gossip is on by default and its sidecar runs under Node.js (libp2p cannot
# run under Bun), so the devnet carries the release image's pinned Node,
# checked against the published sha256. Bump together with the root
# Dockerfile (sha256 from https://nodejs.org/dist/v<version>/SHASUMS256.txt).
# arm64 is listed too so the devnet still builds on Apple Silicon hosts.
ARG NODE_VERSION=22.23.4
ARG NODE_SHA256_X64=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce
ARG NODE_SHA256_ARM64=6287aa46b6c375d816e63ae66d024fbbfd70404825aabdfdf898a970871d2f4b
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    netcat-openbsd \
    xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && case "$(dpkg --print-architecture)" in \
         amd64) node_arch=x64; node_sha="${NODE_SHA256_X64}" ;; \
         arm64) node_arch=arm64; node_sha="${NODE_SHA256_ARM64}" ;; \
         *) echo >&2 "No pinned Node sha256 for $(dpkg --print-architecture)"; exit 1 ;; \
       esac \
    && curl --proto '=https' --tlsv1.2 -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
    && echo "${node_sha}  /tmp/node.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
         --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE' \
    && rm /tmp/node.tar.xz \
    && node --version

# Set working directory
WORKDIR /app

# Copy package files first (for better caching)
COPY package.json bun.lock ./

# Install dependencies at build time (cached if package.json unchanged)
RUN bun install --frozen-lockfile
COPY sidecar/package.json sidecar/bun.lock ./sidecar/
RUN cd sidecar && bun install --frozen-lockfile

# Now copy the rest of the repo
COPY . .

# GossipManager runs sidecar/dist/gossip-sidecar.mjs; .dockerignore keeps the
# host's sidecar/dist out, so the bundle is always built from this tree.
RUN cd sidecar && bun build.mjs

# Default environment
ENV NODE_ENV=development

# Make run-devnet executable
RUN chmod +x ./testing/devnet/run-devnet

ENTRYPOINT ["./testing/devnet/run-devnet"]
CMD []
