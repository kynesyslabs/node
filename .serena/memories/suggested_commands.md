# Suggested Commands

## Essential Development Commands

### Linting and Code Quality
```bash
bun run lint          # Check code quality and formatting
bun run lint:fix      # Auto-fix linting issues (RECOMMENDED AFTER CHANGES)
bun run format        # Format code with Prettier
```

**CRITICAL**: Always run `bun run lint:fix` after making code changes to validate syntax and code quality. Never start the node directly during development.

### Package Management
```bash
bun install                    # Install dependencies
bun update @kynesyslabs/demosdk --latest  # Update SDK to latest version
bun update-interactive --latest           # Interactive dependency updates
```

### Testing
```bash
bun run test:chains   # Run test suite (excludes src/* and test utilities)
```

### Node Operations

**WARNING**: Never start the node directly during development. Use linting for validation.

```bash
# Production/Controlled Environment Only
./run                 # Start database and node (default: port 53550, postgres 5332)
./run -p 8080         # Custom node port
./run -d 5433         # Custom postgres port
./run -i .identity    # Custom identity file
./run -c              # Clean database before start
./run -n              # No git pull (use custom branch)

# Manual node start (after database is running)
bun run start         # Start with tsx
bun run start:bun     # Start with bun runtime
bun run start:clean   # Start with clean chain.db
bun run start:purge   # Start with clean identity and chain.db
```

### Database Operations (TypeORM)
```bash
bun run migration:run       # Run pending migrations
bun run migration:revert    # Revert last migration
bun run migration:generate  # Generate new migration
```

### Utilities
```bash
bun run keygen             # Generate new identity keypair
bun run dump_balance       # Dump balance information
```

## Docker and Database Management

### Database Lifecycle
```bash
# Start database (typically handled by ./run script)
cd postgres_5332
./start.sh
cd ..

# Stop database
cd postgres_5332
./stop.sh
cd ..

# Check Docker status
docker info
docker ps
```

### Port Verification
```bash
# Check if ports are available
sudo lsof -i :5332   # PostgreSQL port
sudo lsof -i :53550  # Node software port
```

## Development Workflow

### Initial Setup
```bash
git clone <repository>
bun install
bun run keygen
cp env.example .env
cp demos_peerlist.json.example demos_peerlist.json
# Edit .env and demos_peerlist.json as needed
```

### Standard Development Cycle
```bash
# 1. Make code changes
# 2. Run linting validation
bun run lint:fix

# 3. Run tests if applicable
bun run test:chains

# 4. For production/testing (controlled environment only)
./run
```

### Troubleshooting
```bash
# Clean database
./run -c

# View logs
tail -f logs/node.log
tail -f postgres_5332/postgres.log

# Check Docker
docker info
docker ps
docker logs <container-name>

# Restart database
cd postgres_5332
./stop.sh
./start.sh
cd ..
```

## System-Specific Notes

### Linux Commands
- Standard Unix commands: `ls`, `cd`, `grep`, `find`, `cat`, etc.
- Git operations: `git status`, `git add`, `git commit`, `git branch`
- Package management: Use `bun` exclusively

### Special Considerations
- **Bun over npm/yarn**: Always prefer Bun for all package operations
- **Never start node in development**: Use `bun run lint:fix` for validation
- **Docker required**: PostgreSQL runs in Docker container
- **Ports must be free**: 5332 (PostgreSQL) and 53550 (node) must be available
