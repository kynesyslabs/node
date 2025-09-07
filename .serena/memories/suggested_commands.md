# Essential Commands for Demos Network Development

## Development Lifecycle

### Initial Setup
```bash
bun install                    # Install dependencies
bun run keygen                 # Generate node identity keys
cp env.example .env            # Set up environment
cp demos_peerlist.json.example demos_peerlist.json  # Configure peers
```

### Daily Development
```bash
./run                          # Start node with database (default ports)
./run -p 53551 -d 5333        # Start with custom ports
./run -c true                  # Clean database on start
./run -n                       # Skip git pull
```

### Code Quality & Testing
```bash
bun run lint                   # Check code style and lint
bun run lint:fix              # Auto-fix linting issues
bun run format                # Format code with prettier
bun test:chains               # Run blockchain tests
```

### Development Scripts
```bash
bun run start:bun             # Run with Bun (preferred)
bun run start:clean           # Remove chain.db and start
bun run start:purge           # Remove identity and chain.db
bun run dev                   # Development mode with auto-reload
```

### Database Management
```bash
bun run migration:generate    # Generate TypeORM migration
bun run migration:run         # Run pending migrations
bun run migration:revert      # Revert last migration
```

### SDK & Dependencies
```bash
bun run upgrade_sdk           # Update @kynesyslabs/demosdk to latest
bun run upgrade_deps          # Interactive dependency updates
```

### System Commands (Darwin/macOS)
```bash
lsof -i :53550                # Check if node port is in use
lsof -i :5332                 # Check if postgres port is in use
docker ps                     # Check running containers
brew services start docker    # Start Docker on macOS
```

## Port Configuration
- **Default Node Port**: 53550
- **Default PostgreSQL Port**: 5332
- **Multiple Instances**: Use different ports for parallel testing

## Important Notes
- Bun is MANDATORY since v0.9.5 (Node.js execution deprecated)
- Docker required for PostgreSQL database management
- Use ./run script instead of direct bun commands for full setup