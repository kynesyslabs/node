# Demos Network Node Software - Essential Commands

## Development Commands

### Code Quality & Linting

```bash
bun run lint                # Check code style and linting
bun run lint:fix            # Auto-fix ESLint issues
bun run format              # Format code with Prettier
bun run prettier-format     # Format specific modules
```

### Node Operations

```bash
bun install                 # Install dependencies
bun run start               # Start the node with tsx
bun run start:bun          # Start with native Bun runtime
bun run start:up           # Install deps and start
bun run start:clean        # Clean database and start
bun run start:purge        # Full purge and start
bun run dev                # Development mode with auto-restart
```

### Database Operations

```bash
bun run migration:generate  # Generate TypeORM migration
bun run migration:run       # Run pending migrations
bun run migration:revert    # Revert last migration
```

### Testing

```bash
bun run test:chains        # Run chain-specific tests
```

### Utilities

```bash
bun run keygen             # Generate cryptographic keys
bun run restore            # Backup and restore utility
bun run upgrade_sdk        # Update @kynesyslabs/demosdk
bun run upgrade_deps       # Interactive dependency updates
```

## Production Commands

### Running the Node

```bash
./run                      # Start database and node (recommended)
./run -p <port>           # Custom node port
./run -d <db_port>        # Custom database port
./run -i <identity>       # Custom identity file
./run -c                  # Clean database before start
./run -n                  # Skip git pull
```

## System Commands (macOS/Darwin)

### Essential Unix Tools

```bash
ls -la                     # List files with details
cd /path/to/dir           # Change directory (use /usr/bin/zoxide if available)
grep -r "pattern" src/    # Search in files (prefer `rg` if available)
find . -name "*.ts"       # Find files by pattern
```

### Process Management

```bash
lsof -i :53550            # Check if node port is in use
lsof -i :5332             # Check if database port is in use
ps aux | grep node        # Find Node.js processes
kill -9 <pid>             # Force kill process
```

### Docker Operations

```bash
docker info               # Check Docker status
docker ps                 # List running containers
docker compose up -d      # Start services in background
docker compose down       # Stop services
```

## Git Workflow

```bash
git status                # Check current status
git branch                # List branches
git checkout -b feature/name  # Create feature branch
git add .                 # Stage changes
git commit -m "message"   # Commit changes
```

## Troubleshooting Commands

```bash
# Check system requirements
node --version            # Should be 20.x+
bun --version            # Should be latest
docker --version         # Should be latest

# Port diagnostics
sudo lsof -i :5332       # PostgreSQL port
sudo lsof -i :53550      # Node port

# Log inspection
tail -f logs/node.log    # Node logs
tail -f postgres_*/postgres.log  # Database logs
```
