#!/bin/bash
# Attach to a running devnet container with an interactive shell
# Usage: ./scripts/attach.sh [node-1|node-2|node-3|node-4|postgres]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVNET_DIR="$(dirname "$SCRIPT_DIR")"
cd "$DEVNET_DIR"

SERVICE=${1:-node-1}

case "$SERVICE" in
    node-1|node-2|node-3|node-4)
        CONTAINER="demos-devnet-$SERVICE"
        echo "🔗 Attaching to $CONTAINER..."
        docker exec -it "$CONTAINER" /bin/bash
        ;;
    postgres)
        CONTAINER="demos-devnet-postgres"
        echo "🔗 Attaching to $CONTAINER (psql)..."
        source "$DEVNET_DIR/.env" 2>/dev/null || true
        docker exec -it "$CONTAINER" psql -U "${POSTGRES_USER:-demosuser}" -d postgres
        ;;
    *)
        echo "Usage: $0 [node-1|node-2|node-3|node-4|postgres]"
        echo ""
        echo "Attaches to a running container with interactive shell."
        echo "For postgres, opens psql client."
        exit 1
        ;;
esac
