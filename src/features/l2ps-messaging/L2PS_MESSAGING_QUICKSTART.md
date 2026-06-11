# L2PS Messaging Quick Start Guide

Real-time instant messaging backed by L2PS rollup. Messages are delivered instantly via WebSocket and persisted through the L2PS batch → proof → L1 pipeline.

---

## Overview

L2PS Messaging provides encrypted real-time chat on top of the Demos L2PS infrastructure. Key features:
- **Instant delivery** — Messages routed via WebSocket in real-time
- **L2PS persistence** — Every message becomes an L2PS transaction, batched and rolled up to L1
- **Instant finality for messages** — Non-state-changing messages (text, reactions) are final once L2PS participants validate the signature + timestamp
- **E2E encryption** — Messages encrypted client-side before transmission
- **Offline delivery** — Messages queued when recipient is offline, delivered on reconnect
- **Conversation history** — Queryable from the node with authenticated proof

---

## 1. Prerequisites

### L2PS Network

An L2PS network must be set up and running. See [L2PS Quick Start](../../libs/l2ps/L2PS_QUICKSTART.md) for details.

Verify your L2PS network is loaded:
```text
[L2PS] Loaded network: testnet_l2ps_001
```

### Node Running

```bash
./run
```text

---

## 2. Enable L2PS Messaging

### Environment Configuration

Add to your `.env`:

```bash
L2PS_MESSAGING_ENABLED=true
L2PS_MESSAGING_PORT=3006
```

### Restart Node

```bash
./run
```text

Watch for:
```
[L2PS-IM] Messaging server started on port 3006
```text

---

## 3. WebSocket Protocol

Connect to `ws://localhost:3006` (or your configured port).

### 3.1 Register

Before sending messages, register with your ed25519 key and target L2PS network:

```json
{
  "type": "register",
  "payload": {
    "publicKey": "<your_ed25519_public_key_hex>",
    "l2psUid": "testnet_l2ps_001",
    "proof": "<signature_of_'register:{publicKey}:{timestamp}'>"
  },
  "timestamp": 1709312400000
}
```

**Response:**
```json
{
  "type": "registered",
  "payload": {
    "success": true,
    "publicKey": "<your_key>",
    "l2psUid": "testnet_l2ps_001",
    "onlinePeers": ["<peer_key_1>", "<peer_key_2>"]
  },
  "timestamp": 1709312400001
}
```text

### 3.2 Send Message

```json
{
  "type": "send",
  "payload": {
    "to": "<recipient_public_key_hex>",
    "encrypted": {
      "ciphertext": "<base64_encrypted_data>",
      "nonce": "<base64_aes_gcm_nonce>",
      "ephemeralKey": "<hex_x25519_ephemeral_key>"
    },
    "messageHash": "<sha256_of_plaintext>"
  },
  "timestamp": 1709312400000
}
```

**Response (recipient online):**
```json
{
  "type": "message_sent",
  "payload": {
    "messageHash": "<hash>",
    "l2psStatus": "submitted"
  },
  "timestamp": 1709312400001
}
```text

**Response (recipient offline):**
```json
{
  "type": "message_queued",
  "payload": {
    "messageHash": "<hash>",
    "status": "queued"
  },
  "timestamp": 1709312400001
}
```

### 3.3 Receive Message

Messages arrive as:
```json
{
  "type": "message",
  "payload": {
    "from": "<sender_public_key_hex>",
    "encrypted": {
      "ciphertext": "<base64>",
      "nonce": "<base64>"
    },
    "messageHash": "<hash>",
    "offline": false
  },
  "timestamp": 1709312400000
}
```text

`offline: true` means the message was delivered from the offline queue.

### 3.4 Get History

```json
{
  "type": "history",
  "payload": {
    "peerKey": "<other_peer_public_key>",
    "before": 1709312400000,
    "limit": 50,
    "proof": "<signature_of_'history:{peerKey}:{timestamp}'>"
  },
  "timestamp": 1709312400000
}
```

**Response:**
```json
{
  "type": "history_response",
  "payload": {
    "messages": [
      {
        "id": "uuid",
        "from": "<key>",
        "to": "<key>",
        "messageHash": "<hash>",
        "encrypted": { "ciphertext": "...", "nonce": "..." },
        "l2psUid": "testnet_l2ps_001",
        "l2psTxHash": "<l2ps_tx_hash>",
        "timestamp": 1709312400000,
        "status": "delivered"
      }
    ],
    "hasMore": true
  },
  "timestamp": 1709312400001
}
```text

### 3.5 Discover Online Peers

```json
{
  "type": "discover",
  "payload": {},
  "timestamp": 1709312400000
}
```

**Response:**
```json
{
  "type": "discover_response",
  "payload": {
    "peers": ["<key1>", "<key2>"]
  },
  "timestamp": 1709312400001
}
```text

### 3.6 Request Public Key

```json
{
  "type": "request_public_key",
  "payload": { "targetId": "<peer_public_key>" },
  "timestamp": 1709312400000
}
```

### 3.7 Notifications

**Peer joined:**
```json
{ "type": "peer_joined", "payload": { "publicKey": "<key>" }, "timestamp": ... }
```text

**Peer left:**
```json
{ "type": "peer_left", "payload": { "publicKey": "<key>" }, "timestamp": ... }
```

---

## 4. Message Flow

```text
Sender (SDK)                       Node                         Recipient (SDK)
    │                               │                                │
    │  1. Encrypt message           │                                │
    │  2. Sign envelope             │                                │
    │  3. WS: send ────────────►    │                                │
    │                               │  4. Validate                   │
    │                               │  5. Route via WS ─────────►    │  (instant)
    │                               │  6. Store in l2ps_messages     │
    │                               │  7. Create L2PS transaction    │
    │                               │  8. Encrypt → L2PS mempool     │
    │                               │                                │
    │  ◄── message_sent             │  9. Batch aggregation (10s)    │
    │                               │  10. ZK proof + L1 rollup      │
    │                               │                                │
```

### Message Finality

| Message Type | Finality | Wait Time |
|-------------|----------|-----------|
| Text, reactions, system | **Instant** — once L2PS participants validate signature + timestamp | ~0s |
| Token transfers (future) | **L1 finality** — must wait for block confirmation | ~10-20s |

This is because non-state-changing messages can't be disputed — the cryptographic proof is sufficient.

---

## 5. Message Status Lifecycle

| Status | Meaning |
|--------|---------|
| ⚡ **delivered** | Sent to recipient via WebSocket |
| 📬 **queued** | Recipient offline, stored for later |
| ✉️ **sent** | Delivered from offline queue |
| 🔄 **l2ps_pending** | In L2PS mempool |
| 📦 **l2ps_batched** | Included in L2PS batch |
| ✓ **l2ps_confirmed** | Confirmed on L1 |
| ❌ **failed** | L2PS submission or transaction execution failed (terminal) |

---

## 6. Running Tests

```bash
bun test src/features/l2ps-messaging/tests/
```text

Expected output:
```
bun test v1.3.3

 37 pass
 0 fail
 78 expect() calls
Ran 37 tests across 2 files.
```text

---

## 7. Environment Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `L2PS_MESSAGING_ENABLED` | Enable messaging server | `false` |
| `L2PS_MESSAGING_PORT` | WebSocket server port | `3006` |

The messaging server also depends on L2PS configuration — see [L2PS Quick Start](../../libs/l2ps/L2PS_QUICKSTART.md) for `L2PS_*` variables.

---

## 8. Database

Messages are stored in the `l2ps_messages` table:

```sql
-- Check message counts by status
SELECT status, COUNT(*) FROM l2ps_messages GROUP BY status;

-- Recent messages
SELECT id, from_key, to_key, status, l2ps_tx_hash, timestamp
FROM l2ps_messages ORDER BY timestamp DESC LIMIT 20;

-- Conversation between two peers
SELECT * FROM l2ps_messages
WHERE l2ps_uid = 'testnet_l2ps_001'
  AND ((from_key = '<keyA>' AND to_key = '<keyB>')
    OR (from_key = '<keyB>' AND to_key = '<keyA>'))
ORDER BY timestamp DESC LIMIT 50;
```

---

## 9. Architecture

```text
src/features/l2ps-messaging/
├── index.ts                    # Feature exports, init/shutdown
├── L2PSMessagingServer.ts      # Bun WebSocket server (real-time delivery)
├── L2PSMessagingService.ts     # Bridge: messages → L2PS mempool
├── types.ts                    # Protocol types, message envelope
├── entities/
│   └── L2PSMessage.ts          # TypeORM entity (l2ps_messages table)
└── tests/
    ├── L2PSMessagingServer.test.ts   # Protocol & routing tests
    └── L2PSMessagingService.test.ts  # Service logic tests
```

### Key Components

| Component | Responsibility |
|-----------|---------------|
| **L2PSMessagingServer** | WebSocket connections, peer registry, message routing, offline delivery |
| **L2PSMessagingService** | DB persistence, L2PS transaction creation, mempool submission, history queries |
| **L2PSMessage** | Database entity — stores encrypted messages with L2PS metadata |

### How Messages Become L2PS Transactions

1. Message received via WebSocket
2. Service creates a `Transaction` with `type: "instantMessaging"`, `gcr_edits: []`, `amount: 0`
3. Transaction signed with node's ed25519 key
4. Encrypted via `ParallelNetworks.encryptTransaction()` (AES-256-GCM)
5. Submitted to `L2PSMempool.addTransaction()`
6. Executed by `L2PSTransactionExecutor.execute()` (lightweight — no state changes)
7. Batch Aggregator picks it up every 10s → creates proof → submits to L1

---

## 10. Error Codes

| Code | Meaning |
|------|---------|
| `INVALID_MESSAGE` | Malformed WebSocket frame |
| `REGISTRATION_REQUIRED` | Must register before sending |
| `INVALID_PROOF` | Signature verification failed |
| `PEER_NOT_FOUND` | Target peer not connected |
| `L2PS_NOT_FOUND` | L2PS network UID not loaded |
| `L2PS_SUBMIT_FAILED` | Failed to submit to L2PS mempool |
| `RATE_LIMITED` | Too many offline messages from sender |
| `INTERNAL_ERROR` | Unexpected server error |

---

## 11. Troubleshooting

### "L2PS network not found"
- Ensure L2PS network is configured in `data/l2ps/<uid>/config.json`
- Check node logs for `[L2PS] Loaded network: <uid>`

### "Signature verification failed"
- Proof must be: `sign("register:{publicKey}:{timestamp}")` for register
- Proof must be: `sign("history:{peerKey}:{timestamp}")` for history
- Ensure timestamp matches the frame's `timestamp` field

### "Offline message limit reached"
- Max 200 queued messages per sender
- Limit resets when recipient comes online and messages are delivered

### Messages not appearing in L2PS
- Check `L2PS_MESSAGING_ENABLED=true` in `.env`
- Verify L2PS mempool is working: `SELECT COUNT(*) FROM l2ps_mempool;`
- Check logs for `[L2PS-IM]` entries

### Check Logs

```bash
# Messaging server activity
grep "L2PS-IM" logs/*.log | tail -20

# Message submissions
grep "submitted to L2PS" logs/*.log

# Errors
grep "L2PS-IM.*error" logs/*.log
```text

---

## Related Documentation

- [L2PS Quick Start](../../libs/l2ps/L2PS_QUICKSTART.md) — L2PS network setup
- [L2PS Architecture](../../libs/l2ps/L2PS_DTR_IMPLEMENTATION.md) — Technical architecture
- [ZK Proof System](../../libs/l2ps/zk/README.md) — ZK proof details
