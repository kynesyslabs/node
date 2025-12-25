# Demos Network Devnet Node
FROM oven/bun:latest

# Install system dependencies (including build tools for native modules)
RUN apt-get update && apt-get install -y \
    curl \
    netcat-openbsd \
    build-essential \
    python3 \
    python3-setuptools \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files first (for better caching)
COPY package.json bun.lock ./

# Install dependencies at build time (cached if package.json unchanged)
RUN bun install
RUN bun pm trust --all || true

# Install native websocket modules explicitly
RUN bun add bufferutil utf-8-validate

# Now copy the rest of the repo
COPY . .

# Default environment
ENV NODE_ENV=development

# Make run-devnet executable
RUN chmod +x ./devnet/run-devnet

ENTRYPOINT ["./devnet/run-devnet"]
CMD []
