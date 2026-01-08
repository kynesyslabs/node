# L2PS Quick Start Guide

How to set up and test L2PS (Layer 2 Private System) with ZK proofs.

---

## 1. L2PS Network Setup

### Create Configuration Directory

```bash
mkdir -p data/l2ps/testnet_l2ps_001
```

### Generate Encryption Keys

```bash
# Generate AES-256 key (32 bytes)
openssl rand -hex 32 > data/l2ps/testnet_l2ps_001/private_key.txt

# Generate IV (16 bytes)
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

Or for stress testing, generate test wallets:

```bash
npx tsx scripts/generate-test-wallets.ts --count 10
# Restart node after for genesis changes
```

---

## 4. Start Node

```bash
./run
```

---

## 5. Running Tests

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

## 6. Verify Results

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

### Expected Results

For 50 transactions (with default `MAX_BATCH_SIZE=10`):

| Metric | Expected |
|--------|----------|
| Proofs in DB | ~5 (1 per batch) |
| L1 batch transactions | ~5 |
| Mempool status | batched/confirmed |

---

## 7. Transaction Flow

```
User Transactions          Batch Aggregator           L1 Chain
      │                         │                        │
TX 1 ─┤                         │                        │
TX 2 ─┤  (GCR edits stored)     │                        │
TX 3 ─┼────────────────────────→│                        │
TX 4 ─┤       in mempool        │   (every 10 sec)       │
TX 5 ─┤                         │                        │
      │                         │  Aggregate GCR edits   │
      │                         │  Generate ZK proof     │
      │                         │  Create 1 batch tx ───→│
      │                         │  Create 1 proof        │
      │                         │                        │  Consensus applies
      │                         │                        │  GCR edits to L1
```

---

## 8. Environment Configuration

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

See `.env.example` for all options.

---

## 9. ZK Proof Performance

| Batch Size | Constraints | Proof Time | Verify Time |
|------------|-------------|------------|-------------|
| 5 tx | 37K | ~20s | ~15ms |
| 10 tx | 74K | ~40s | ~15ms |

---

## 10. Troubleshooting

### "L2PS config not found"
- Check `data/l2ps/<uid>/config.json` exists

### "Missing L2PS key material"
- Ensure `private_key.txt` and `iv.txt` exist with valid hex values

### "Insufficient L1 balance"
- Use a genesis wallet or fund the account first

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

## 11. File Structure

```
node/
├── data/l2ps/testnet_l2ps_001/
│   ├── config.json       # L2PS network config
│   ├── private_key.txt   # AES-256 key
│   └── iv.txt            # Initialization vector
├── src/libs/l2ps/zk/
│   ├── scripts/setup_all_batches.sh  # ZK setup script
│   ├── keys/             # Generated ZK keys (gitignored)
│   └── ptau/             # Powers of tau (gitignored)
├── scripts/
│   ├── send-l2-batch.ts        # Quick test
│   ├── l2ps-load-test.ts       # Load test
│   └── l2ps-stress-test.ts     # Stress test
└── mnemonic.txt          # Your wallet
```

---

## Related Documentation

- [L2PS_TESTING.md](../L2PS_TESTING.md) - Comprehensive validation checklist
- [ZK README](../src/libs/l2ps/zk/README.md) - ZK proof system details
- [L2PS_DTR_IMPLEMENTATION.md](../src/libs/l2ps/L2PS_DTR_IMPLEMENTATION.md) - Architecture
