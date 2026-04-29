#!/bin/bash
# Staggered devnet startup to avoid genesis sync race condition.
# Node-1 needs to fully initialize genesis before other nodes try to sync with it.
set -e
cd "$(dirname "$0")"

echo "Starting postgres + tlsnotary..."
docker compose up -d postgres tlsnotary

echo "Waiting for postgres to be healthy..."
until docker compose exec postgres pg_isready -U demosuser -d postgres > /dev/null 2>&1; do
  sleep 1
done
echo "Postgres ready."

echo "Starting node-1..."
docker compose up -d node-1
echo "Waiting 20s for node-1 to initialize genesis..."
sleep 20

# Verify node-1 is responding
for i in 1 2 3 4 5; do
  RESULT=$(curl -s --connect-timeout 3 http://localhost:53551 -X POST \
    -H 'Content-Type: application/json' \
    -d '{"method":"nodeCall","params":[{"message":"getLastBlockNumber"}]}' 2>/dev/null)
  if [ -n "$RESULT" ]; then
    echo "Node-1 responding: $RESULT"
    break
  fi
  echo "Node-1 not ready yet (attempt $i/5), waiting 10s..."
  sleep 10
done

echo "Starting nodes 2, 3, 4..."
docker compose up -d node-2 node-3 node-4

echo "Devnet started. Monitoring block production..."
for i in 1 2 3 4 5 6; do
  sleep 15
  echo "=== Check $i ==="
  for port in 53551 53552 53553 53554; do
    RESULT=$(curl -s --connect-timeout 3 http://localhost:$port -X POST \
      -H 'Content-Type: application/json' \
      -d '{"method":"nodeCall","params":[{"message":"getLastBlockNumber"}]}' 2>/dev/null)
    echo "  :$port -> $RESULT"
  done
done
