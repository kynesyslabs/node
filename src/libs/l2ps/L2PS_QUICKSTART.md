# L2PS Quick Start Guide

Complete guide to set up and test L2PS (Layer 2 Privacy Subnets) with ZK proofs.

---

## Overview

L2PS provides private transactions on top of the Demos blockchain. Key features:
- **Client-side encryption** - Transactions encrypted before leaving wallet
- **Batch aggregation** - Multiple L2PS tx → single L1 tx
- **ZK proofs** - Cryptographic validity verification
- **1 DEM transaction fee** - Burned per L2PS transaction

---

## 1. L2PS Network Setup

### Create Configuration Directory

```bash
mkdir -p data/l2ps/testnet_l2ps_001
```

### Generate Encryption Keys

```bash
# Generate AES-256 key (32 bytes = 64 hex chars)
openssl rand -hex 32 > data/l2ps/testnet_l2ps_001/private_key.txt

# Generate IV (16 bytes = 32 hex chars)
openssl rand -hex 16 > data/l2ps/testnet_l2ps_001/iv.txt
```

### Create Config File

Create `data/l2ps/testnet_l2ps_001/config.json`:

```json
{
  "uid": "testnet_l2ps_001",
  "enabled": true,
  "config": {
    "created_at_block": 0,
    "known_rpcs": ["http://127.0.0.1:53550"]
  },
  "keys": {
    "private_key_path": "data/l2ps/testnet_l2ps_001/private_key.txt",
    "iv_path": "data/l2ps/testnet_l2ps_001/iv.txt"
  }
}
```

---

## 2. ZK Proof Setup (PLONK)

ZK proofs provide cryptographic verification of L2PS batch validity.

### Install circom (one-time)

```bash
curl -Ls https://scrypt.io/scripts/setup-circom.sh | sh
```

### Generate ZK Keys (~2 minutes)

```bash
cd src/libs/l2ps/zk/scripts
./setup_all_batches.sh
cd -
```

This downloads ptau files (~200MB) and generates proving keys (~350MB).

**Files generated:**
```
src/libs/l2ps/zk/
├── keys/
│   ├── batch_5/   # For 1-5 tx batches (~37K constraints)
│   └── batch_10/  # For 6-10 tx batches (~74K constraints)
└── ptau/          # Powers of tau files
```

**Without ZK keys**: System works but batches are submitted without proofs (graceful degradation).

---

## 3. Wallet Setup

Create `mnemonic.txt` with a funded wallet:

```bash
echo "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" > mnemonic.txt
```

Or generate test wallets with pre-funded balances:

```bash
npx tsx scripts/generate-test-wallets.ts --count 10
# Restart node after for genesis changes
```

---

## 4. Start Node

```bash
./run
```

Watch for L2PS initialization logs:
```
[L2PS] Loaded network: testnet_l2ps_001
[L2PS Batch Aggregator] Started
```

---

## 5. POC Application Setup

The POC app provides a visual interface to test L2PS transactions.

### Install and Run

```bash
cd docs/poc-app
npm install
npm run dev
# Open http://localhost:5173
```

### Configure Keys

Create `docs/poc-app/.env`:

```bash
VITE_NODE_URL="http://127.0.0.1:53550"
VITE_L2PS_UID="testnet_l2ps_001"

# MUST match the node keys!
VITE_L2PS_AES_KEY="<contents of data/l2ps/testnet_l2ps_001/private_key.txt>"
VITE_L2PS_IV="<contents of data/l2ps/testnet_l2ps_001/iv.txt>"
```

**Quick copy:**
```bash
echo "VITE_NODE_URL=\"http://127.0.0.1:53550\"" > docs/poc-app/.env
echo "VITE_L2PS_UID=\"testnet_l2ps_001\"" >> docs/poc-app/.env
echo "VITE_L2PS_AES_KEY=\"$(cat data/l2ps/testnet_l2ps_001/private_key.txt)\"" >> docs/poc-app/.env
echo "VITE_L2PS_IV=\"$(cat data/l2ps/testnet_l2ps_001/iv.txt)\"" >> docs/poc-app/.env
```

### POC Features

| Feature | Description |
|---------|-------------|
| **Send L1/L2PS** | Toggle between public and private transactions |
| **Transaction History** | View L1, L2PS, or All transactions |
| **Learn Tab** | Interactive demos explaining L2PS |
| **Privacy Demo** | Try authenticated vs unauthenticated access |

---

## 6. Running Tests

### Quick Test (5 transactions)

```bash
npx tsx scripts/send-l2-batch.ts --uid testnet_l2ps_001
```

### Load Test (single wallet)

```bash
npx tsx scripts/l2ps-load-test.ts --uid testnet_l2ps_001 --count 50 --delay 50
```

Options:
| Flag | Description | Default |
|------|-------------|---------|
| `--node <url>` | Node RPC URL | http://127.0.0.1:53550 |
| `--uid <uid>` | L2PS network UID | testnet_l2ps_001 |
| `--count <n>` | Number of transactions | 100 |
| `--value <amount>` | Amount per tx | 1 |
| `--delay <ms>` | Delay between tx | 50 |

### Stress Test (multiple wallets)

```bash
npx tsx scripts/l2ps-stress-test.ts --uid testnet_l2ps_001 --count 100
```

---

## 7. Transaction Flow

```
User Transactions          Batch Aggregator           L1 Chain
      │                         │                        │
TX 1 ─┤  (encrypted)            │                        │
TX 2 ─┤  (1 DEM fee each)       │                        │
TX 3 ─┼────────────────────────→│                        │
TX 4 ─┤       in mempool        │   (every 10 sec)       │
TX 5 ─┤                         │                        │
      │                         │  Aggregate GCR edits   │
      │                         │  Generate ZK proof     │
      │                         │  Create 1 batch tx ───→│
      │                         │                        │
      │                         │                        │ Consensus applies
      │                         │                        │ GCR edits to L1
```

### Transaction Status Flow

| Status | Meaning |
|--------|---------|
| ⚡ **Executed** | Local node validated and decrypted |
| 📦 **Batched** | Included in L1 batch transaction |
| ✓ **Confirmed** | L1 block confirmed |

---

## 8. Verify Results

Wait ~15 seconds for batch aggregation, then check:

### Check Proofs

```bash
docker exec -it postgres_5332 psql -U demosuser -d demos -c \
  "SELECT id, l2ps_uid, transaction_count, status FROM l2ps_proofs ORDER BY id DESC LIMIT 10;"
```

### Check Mempool Status

```bash
docker exec -it postgres_5332 psql -U demosuser -d demos -c \
  "SELECT status, COUNT(*) FROM l2ps_mempool GROUP BY status;"
```

### Check L2PS Transactions

```bash
docker exec -it postgres_5332 psql -U demosuser -d demos -c \
  "SELECT hash, from_address, amount, status FROM l2ps_transactions ORDER BY id DESC LIMIT 10;"
```

### Expected Results

For 50 transactions (with default `MAX_BATCH_SIZE=10`):

| Metric | Expected |
|--------|----------|
| Proofs in DB | ~5 (1 per batch) |
| L1 batch transactions | ~5 |
| Mempool status | batched/confirmed |
| Total fees burned | 50 DEM |

---

## 9. Environment Configuration

L2PS settings can be configured via environment variables in `.env`:

| Variable | Description | Default |
|----------|-------------|---------|
| `L2PS_AGGREGATION_INTERVAL_MS` | Batch aggregation interval | 10000 (10s) |
| `L2PS_MIN_BATCH_SIZE` | Min transactions to batch | 1 |
| `L2PS_MAX_BATCH_SIZE` | Max transactions per batch | 10 (ZK limit) |
| `L2PS_CLEANUP_AGE_MS` | Cleanup confirmed tx after | 300000 (5m) |
| `L2PS_HASH_INTERVAL_MS` | Hash relay interval | 5000 (5s) |

Example `.env`:
```bash
L2PS_AGGREGATION_INTERVAL_MS=5000   # Faster batching (5s)
L2PS_MAX_BATCH_SIZE=5               # Smaller batches
```

---

## 10. ZK Proof Performance

| Batch Size | Constraints | Proof Time | Verify Time |
|------------|-------------|------------|-------------|
| 5 tx | 37K | ~20s | ~15ms |
| 10 tx | 74K | ~40s | ~15ms |

---

## 11. Troubleshooting

### "L2PS config not found"
- Check `data/l2ps/<uid>/config.json` exists

### "Missing L2PS key material"
- Ensure `private_key.txt` and `iv.txt` exist with valid hex values

### "Insufficient L1 balance"
- Remember: amount + 1 DEM fee required
- Use a genesis wallet or fund the account first

### "Client keys don't match node"
- POC `.env` keys must exactly match node keys
- Use the quick copy command in section 5

### "ZK Prover not available"
- Run `src/libs/l2ps/zk/scripts/setup_all_batches.sh`
- System still works without ZK (graceful degradation)

### Check Logs

```bash
# Batch aggregator activity
grep "L2PS Batch Aggregator" logs/*.log | tail -20

# Proof creation
grep "Created aggregated proof" logs/*.log

# ZK proof generation
grep "ZK proof generated" logs/*.log
```

---

## 12. File Structure

```
node/
├── data/l2ps/testnet_l2ps_001/
│   ├── config.json       # L2PS network config
│   ├── private_key.txt   # AES-256 key (64 hex chars)
│   └── iv.txt            # Initialization vector (32 hex chars)
├── docs/poc-app/
│   ├── src/App.tsx       # POC application
│   └── .env              # Client configuration
├── src/libs/l2ps/
│   ├── L2PSTransactionExecutor.ts  # Transaction processing
│   ├── L2PSBatchAggregator.ts      # Batch creation
│   └── zk/               # ZK proof system
├── scripts/
│   ├── send-l2-batch.ts        # Quick test
│   ├── l2ps-load-test.ts       # Load test
│   └── l2ps-stress-test.ts     # Stress test
└── mnemonic.txt          # Your wallet
```

---

## 13. Summary: Complete Setup Checklist

```bash
# 1. Create L2PS network
mkdir -p data/l2ps/testnet_l2ps_001
openssl rand -hex 32 > data/l2ps/testnet_l2ps_001/private_key.txt
openssl rand -hex 16 > data/l2ps/testnet_l2ps_001/iv.txt

# 2. Create config.json (see section 1)

# 3. Optional: Setup ZK proofs
cd src/libs/l2ps/zk/scripts && ./setup_all_batches.sh && cd -

# 4. Start node
./run

# 5. Setup POC app
cd docs/poc-app && npm install

# 6. Copy keys to POC
echo "VITE_NODE_URL=\"http://127.0.0.1:53550\"" > .env
echo "VITE_L2PS_UID=\"testnet_l2ps_001\"" >> .env
echo "VITE_L2PS_AES_KEY=\"$(cat ../../data/l2ps/testnet_l2ps_001/private_key.txt)\"" >> .env
echo "VITE_L2PS_IV=\"$(cat ../../data/l2ps/testnet_l2ps_001/iv.txt)\"" >> .env

# 7. Run POC
npm run dev
```

---

## Related Documentation

- [POC App README](../../docs/poc-app/README.md) - POC application details
- [L2PS Architecture](L2PS_DTR_IMPLEMENTATION.md) - Technical architecture
- [ZK README](zk/README.md) - ZK proof system details
