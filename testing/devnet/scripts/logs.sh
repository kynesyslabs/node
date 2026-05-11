#!/bin/bash
# View logs from devnet nodes
# Usage: ./scripts/logs.sh [node-1|node-2|node-3|node-4|postgres|all]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVNET_DIR="$(dirname "${SCRIPT_DIR}")"
cd "${DEVNET_DIR}" || exit

SERVICE=${1:-all}

case "${SERVICE}" in
all)
	echo "📋 Following logs from all services..."
	docker compose logs -f --tail=50
	;;
nodes)
	echo "📋 Following logs from all nodes..."
	docker compose logs -f --tail=50 node-1 node-2 node-3 node-4
	;;
node-1 | node-2 | node-3 | node-4 | postgres)
	echo "📋 Following logs from ${SERVICE}..."
	docker compose logs -f --tail=100 "${SERVICE}"
	;;
*)
	echo "Usage: $0 [node-1|node-2|node-3|node-4|nodes|postgres|all]"
	echo ""
	echo "Options:"
	echo "  all      - All services (default)"
	echo "  nodes    - All 4 nodes only"
	echo "  node-1   - Node 1 only"
	echo "  node-2   - Node 2 only"
	echo "  node-3   - Node 3 only"
	echo "  node-4   - Node 4 only"
	echo "  postgres - PostgreSQL only"
	exit 1
	;;
esac
