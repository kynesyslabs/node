# Demos Network Devnet Node
FROM oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f

# No compiler: lifecycle scripts are blocked and the native modules the
# node uses ship prebuilt binaries.
RUN apt-get update && apt-get install -y \
    curl \
    netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files first (for better caching)
COPY package.json bun.lock ./

# Install dependencies at build time (cached if package.json unchanged)
RUN bun install --frozen-lockfile

# Now copy the rest of the repo
COPY . .

# Default environment
ENV NODE_ENV=development

# Make run-devnet executable
RUN chmod +x ./testing/devnet/run-devnet

ENTRYPOINT ["./testing/devnet/run-devnet"]
CMD []
