# OmniProtocol - Step 5: Payload Structures

## Design Philosophy

This step defines binary payload formats for all 9 opcode categories from Step 2. Each payload structure:
- Replicates existing HTTP/JSON functionality
- Uses efficient binary encoding
- Maintains backward compatibility semantics
- Minimizes bandwidth overhead

### Encoding Conventions

**Data Types:**
- **uint8**: 1 byte unsigned integer (0-255)
- **uint16**: 2 bytes unsigned integer, big-endian (0-65,535)
- **uint32**: 4 bytes unsigned integer, big-endian
- **uint64**: 8 bytes unsigned integer, big-endian
- **string**: Length-prefixed UTF-8 (2 bytes length + variable data)
- **bytes**: Length-prefixed raw bytes (2 bytes length + variable data)
- **hash**: 32 bytes fixed (SHA-256)
- **boolean**: 1 byte (0x00=false, 0x01=true)

**Array Encoding:**
```
┌──────────────┬────────────────────────────┐
│  Count       │  Elements                   │
│  2 bytes     │  [Element 1][Element 2]...  │
└──────────────┴────────────────────────────┘
```

---

## Category 0x0X - Control & Infrastructure

**Already defined in Step 3** (Peer Discovery & Handshake)

### Summary of Control Messages:

| Opcode | Name | Request Size | Response Size | Reference |
|--------|------|--------------|---------------|-----------|
| 0x00 | ping | 0 bytes | 10 bytes | Step 3 |
| 0x01 | hello_peer | ~265 bytes | ~65 bytes | Step 3 |
| 0x02 | auth | TBD | TBD | Extension of 0x01 |
| 0x03 | nodeCall | Variable | Variable | Wrapper (see below) |
| 0x04 | getPeerlist | 4 bytes | Variable | Step 3 |

### 0x03 - nodeCall (HTTP Compatibility Wrapper)

**Purpose**: Wrap all SDK-compatible query methods for backward compatibility during migration

**Request Payload:**
```
┌──────────────┬──────────────┬────────────────┬──────────────┬───────────────┐
│  Method Len  │  Method Name │  Params Count  │  Param Type  │  Param Data   │
│  2 bytes     │  variable    │  2 bytes       │  1 byte      │  variable     │
└──────────────┴──────────────┴────────────────┴──────────────┴───────────────┘
```

**Method Name**: UTF-8 string (e.g., "getLastBlockNumber", "getAddressInfo")

**Param Type Encoding:**
- 0x01: String (length-prefixed)
- 0x02: Number (8 bytes uint64)
- 0x03: Boolean (1 byte)
- 0x04: Object (JSON-encoded string, length-prefixed)
- 0x05: Array (count-based, recursive param encoding)
- 0x06: Null (0 bytes)

**Response Payload:**
```
┌──────────────┬──────────────┬───────────────┐
│ Status Code  │  Result Type │  Result Data  │
│  2 bytes     │  1 byte      │  variable     │
└──────────────┴──────────────┴───────────────┘
```

**Example - getLastBlockNumber:**
```
Request:
  Method: "getLastBlockNumber" (19 bytes)
  Params: 0 (no params)
  Total: 2 + 19 + 2 = 23 bytes

Response:
  Status: 200 (2 bytes)
  Type: 0x02 (number)
  Data: block number (8 bytes)
  Total: 2 + 1 + 8 = 11 bytes
```

---

## Category 0x1X - Transactions & Execution

### Transaction Structure (Common)

All transaction opcodes share this common transaction structure:

```
┌─────────────────────────────────────────────────────────────────┐
│                     TRANSACTION CONTENT                          │
├─────────────────────────────────────────────────────────────────┤
│  Type (1 byte)                                                   │
│    0x01 = Transfer                                               │
│    0x02 = Contract Deploy                                        │
│    0x03 = Contract Call                                          │
│    0x04 = GCR Edit                                               │
│    0x05 = Bridge Operation                                       │
├─────────────────────────────────────────────────────────────────┤
│  From Address (length-prefixed string)                           │
│    - Address Length: 2 bytes                                     │
│    - Address: variable (hex string)                              │
├─────────────────────────────────────────────────────────────────┤
│  From ED25519 Address (length-prefixed string)                   │
│    - Length: 2 bytes                                             │
│    - Address: variable (hex string, can be empty)                │
├─────────────────────────────────────────────────────────────────┤
│  To Address (length-prefixed string)                             │
│    - Length: 2 bytes                                             │
│    - Address: variable (hex string, can be empty for deploys)    │
├─────────────────────────────────────────────────────────────────┤
│  Amount (8 bytes, uint64)                                        │
│    - Can be 0 for non-transfer transactions                      │
├─────────────────────────────────────────────────────────────────┤
│  Data Array (2 elements)                                         │
│    - Element 1 Length: 2 bytes                                   │
│    - Element 1 Data: variable bytes (can be empty)               │
│    - Element 2 Length: 2 bytes                                   │
│    - Element 2 Data: variable bytes (can be empty)               │
├─────────────────────────────────────────────────────────────────┤
│  GCR Edits Count (2 bytes)                                       │
│    - For each GCR edit:                                          │
│      * Operation Type: 1 byte (0x01=add, 0x02=remove, etc.)      │
│      * Key Length: 2 bytes                                       │
│      * Key: variable string                                      │
│      * Value Length: 2 bytes                                     │
│      * Value: variable string                                    │
├─────────────────────────────────────────────────────────────────┤
│  Nonce (8 bytes, uint64)                                         │
├─────────────────────────────────────────────────────────────────┤
│  Timestamp (8 bytes, uint64, milliseconds)                       │
├─────────────────────────────────────────────────────────────────┤
│  Transaction Fees                                                │
│    - Network Fee: 8 bytes (uint64)                               │
│    - RPC Fee: 8 bytes (uint64)                                   │
│    - Additional Fee: 8 bytes (uint64)                            │
└─────────────────────────────────────────────────────────────────┘
```

**Signature Structure:**
```
┌──────────────┬──────────────┬───────────────┐
│  Algorithm   │  Sig Length  │  Signature    │
│  1 byte      │  2 bytes     │  variable     │
└──────────────┴──────────────┴───────────────┘
```

**Transaction Hash:**
- 32 bytes SHA-256 hash of transaction content

### 0x10 - execute (Submit Transaction)

**Request Payload:**
```
┌─────────────────────────────────────────────┐
│  Transaction Content (variable, see above)   │
├─────────────────────────────────────────────┤
│  Signature (variable, see above)             │
├─────────────────────────────────────────────┤
│  Hash (32 bytes, SHA-256)                    │
└─────────────────────────────────────────────┘
```

**Response Payload:**
```
┌──────────────┬──────────────┬────────────────┐
│ Status Code  │  TX Hash     │  Block Number  │
│  2 bytes     │  32 bytes    │  8 bytes       │
└──────────────┴──────────────┴────────────────┘
```

**Size Analysis:**
- Typical transfer: ~250-350 bytes (vs ~600-800 bytes HTTP JSON)
- **Bandwidth savings: ~60-70%**

### 0x11 - nativeBridge (Native Bridge Operation)

**Request Payload:**
```
┌─────────────────────────────────────────────────────────────────┐
│  Bridge Operation Type (1 byte)                                  │
│    0x01 = Deposit                                                │
│    0x02 = Withdraw                                               │
│    0x03 = Lock                                                   │
│    0x04 = Unlock                                                 │
├─────────────────────────────────────────────────────────────────┤
│  Source Chain ID (2 bytes)                                       │
├─────────────────────────────────────────────────────────────────┤
│  Destination Chain ID (2 bytes)                                  │
├─────────────────────────────────────────────────────────────────┤
│  Token Address Length (2 bytes)                                  │
│  Token Address (variable string)                                 │
├─────────────────────────────────────────────────────────────────┤
│  Amount (8 bytes, uint64)                                        │
├─────────────────────────────────────────────────────────────────┤
│  Recipient Address Length (2 bytes)                              │
│  Recipient Address (variable string)                             │
├─────────────────────────────────────────────────────────────────┤
│  Metadata Length (2 bytes)                                       │
│  Metadata (variable bytes, bridge-specific data)                 │
└─────────────────────────────────────────────────────────────────┘
```

**Response Payload:**
```
┌──────────────┬──────────────┬─────────────────┐
│ Status Code  │  Bridge ID   │  Confirmation   │
│  2 bytes     │  32 bytes    │  variable       │
└──────────────┴──────────────┴─────────────────┘
```

### 0x12-0x14 - External Bridge Operations (Rubic)

**0x12 - bridge (Initiate External Bridge):**
Similar to nativeBridge but includes external provider data

**0x13 - bridge_getTrade (Get Quote):**
```
Request:
┌──────────────┬──────────────┬──────────────┬──────────────┐
│ Source Chain │  Dest Chain  │  Token Addr  │   Amount     │
│  2 bytes     │  2 bytes     │  variable    │  8 bytes     │
└──────────────┴──────────────┴──────────────┴──────────────┘

Response:
┌──────────────┬──────────────┬──────────────┬───────────────┐
│ Status Code  │  Quote ID    │  Est. Amount │  Fee Details  │
│  2 bytes     │  16 bytes    │  8 bytes     │  variable     │
└──────────────┴──────────────┴──────────────┴───────────────┘
```

**0x14 - bridge_executeTrade (Execute Bridge Trade):**
```
Request:
┌──────────────┬────────────────────────────┐
│  Quote ID    │  Execution Parameters      │
│  16 bytes    │  variable                  │
└──────────────┴────────────────────────────┘

Response:
┌──────────────┬──────────────┬───────────────┐
│ Status Code  │  TX Hash     │  Tracking ID  │
│  2 bytes     │  32 bytes    │  16 bytes     │
└──────────────┴──────────────┴───────────────┘
```

### 0x15 - confirm (Transaction Validation/Gas Estimation)

**Request Payload:**
```
┌─────────────────────────────────────────────┐
│  Transaction Content (same as 0x10)          │
│  (without signature and hash)                │
└─────────────────────────────────────────────┘
```

**Response Payload:**
```
┌──────────────┬──────────────┬──────────────┬──────────────┐
│ Status Code  │  Valid Flag  │  Gas Est.    │  Error Msg   │
│  2 bytes     │  1 byte      │  8 bytes     │  variable    │
└──────────────┴──────────────┴──────────────┴──────────────┘
```

### 0x16 - broadcast (Broadcast Signed Transaction)

**Request Payload:**
```
┌─────────────────────────────────────────────┐
│  Signed Transaction (same as 0x10)           │
└─────────────────────────────────────────────┘
```

**Response Payload:**
```
┌──────────────┬──────────────┬───────────────┐
│ Status Code  │  TX Hash     │  Broadcast OK │
│  2 bytes     │  32 bytes    │  1 byte       │
└──────────────┴──────────────┴───────────────┘
```

---

## Category 0x2X - Data Synchronization

### 0x20 - mempool_sync (Mempool Synchronization)

**Request Payload:**
```
┌──────────────┬──────────────┬──────────────┐
│  Our TX Count│  Our Mem Hash│  Block Ref   │
│  2 bytes     │  32 bytes    │  8 bytes     │
└──────────────┴──────────────┴──────────────┘
```

**Response Payload:**
```
┌──────────────┬──────────────┬──────────────┬────────────────┐
│ Status Code  │ Their TX Cnt │ Their Hash   │  TX Hashes     │
│  2 bytes     │  2 bytes     │  32 bytes    │  variable      │
└──────────────┴──────────────┴──────────────┴────────────────┘

TX Hashes Array:
┌──────────────┬────────────────────────────┐
│  Count       │  [Hash 1][Hash 2]...[N]    │
│  2 bytes     │  32 bytes each             │
└──────────────┴────────────────────────────┘
```

**Purpose**: Exchange mempool state, identify missing transactions

### 0x21 - mempool_merge (Mempool Merge Request)

**Request Payload:**
```
┌──────────────┬────────────────────────────┐
│  TX Count    │  Transaction Array         │
│  2 bytes     │  [Full TX 1][TX 2]...[N]   │
└──────────────┴────────────────────────────┘
```

Each transaction encoded as in 0x10 (execute)

**Response Payload:**
```
┌──────────────┬──────────────┬──────────────┐
│ Status Code  │  Accepted    │  Rejected    │
│  2 bytes     │  2 bytes     │  2 bytes     │
└──────────────┴──────────────┴──────────────┘
```

### 0x22 - peerlist_sync (Peerlist Synchronization)

**Request Payload:**
```
┌──────────────┬──────────────┐
│  Our Peer Cnt│  Our List Hash│
│  2 bytes     │  32 bytes    │
└──────────────┴──────────────┘
```

**Response Payload:**
```
┌──────────────┬──────────────┬──────────────┬────────────────┐
│ Status Code  │ Their Peer Cnt│ Their Hash  │  Peer Array    │
│  2 bytes     │  2 bytes     │  32 bytes    │  variable      │
└──────────────┴──────────────┴──────────────┴────────────────┘
```

Peer Array: Same as getPeerlist (0x04) response

### 0x23 - block_sync (Block Synchronization Request)

**Request Payload:**
```
┌──────────────┬──────────────┬──────────────┐
│  Start Block │  End Block   │  Max Blocks  │
│  8 bytes     │  8 bytes     │  2 bytes     │
└──────────────┴──────────────┴──────────────┘
```

**Response Payload:**
```
┌──────────────┬──────────────┬────────────────┐
│ Status Code  │  Block Count │  Blocks Array  │
│  2 bytes     │  2 bytes     │  variable      │
└──────────────┴──────────────┴────────────────┘
```

Each block encoded as compact binary (see below)

### 0x24 - getBlocks (Fetch Block Range)

Same as 0x23 but for read-only queries (no auth required)

### 0x25 - getBlockByNumber (Fetch Specific Block)

**Request Payload:**
```
┌──────────────┐
│  Block Number│
│  8 bytes     │
└──────────────┘
```

**Response Payload:**
```
┌──────────────┬────────────────┐
│ Status Code  │  Block Data    │
│  2 bytes     │  variable      │
└──────────────┴────────────────┘
```

### Block Structure (Common for 0x23-0x26)

```
┌─────────────────────────────────────────────────────────────────┐
│                         BLOCK HEADER                             │
├─────────────────────────────────────────────────────────────────┤
│  Block Number (8 bytes, uint64)                                  │
├─────────────────────────────────────────────────────────────────┤
│  Timestamp (8 bytes, uint64, milliseconds)                       │
├─────────────────────────────────────────────────────────────────┤
│  Previous Hash (32 bytes)                                        │
├─────────────────────────────────────────────────────────────────┤
│  Transactions Root (32 bytes, Merkle root)                       │
├─────────────────────────────────────────────────────────────────┤
│  State Root (32 bytes)                                           │
├─────────────────────────────────────────────────────────────────┤
│  Validator Count (2 bytes)                                       │
│    For each validator:                                           │
│      - Identity Length: 2 bytes                                  │
│      - Identity: variable (public key hex)                       │
│      - Signature Length: 2 bytes                                 │
│      - Signature: variable                                       │
├─────────────────────────────────────────────────────────────────┤
│  Transaction Count (2 bytes)                                     │
│    For each transaction:                                         │
│      - Transaction structure (as in 0x10)                        │
└─────────────────────────────────────────────────────────────────┘
```

### 0x26 - getBlockByHash (Fetch Block by Hash)

**Request Payload:**
```
┌──────────────┐
│  Block Hash  │
│  32 bytes    │
└──────────────┘
```

**Response**: Same as 0x25

### 0x27 - getTxByHash (Fetch Transaction by Hash)

**Request Payload:**
```
┌──────────────┐
│  TX Hash     │
│  32 bytes    │
└──────────────┘
```

**Response Payload:**
```
┌──────────────┬──────────────┬────────────────┐
│ Status Code  │  Block Num   │  Transaction   │
│  2 bytes     │  8 bytes     │  variable      │
└──────────────┴──────────────┴────────────────┘
```

Transaction structure as in 0x10

### 0x28 - getMempool (Get Current Mempool)

**Request Payload:**
```
┌──────────────┐
│  Max TX Count│
│  2 bytes     │
└──────────────┘
```

**Response Payload:**
```
┌──────────────┬──────────────┬────────────────┐
│ Status Code  │  TX Count    │  TX Array      │
│  2 bytes     │  2 bytes     │  variable      │
└──────────────┴──────────────┴────────────────┘
```

---

## Category 0x3X - Consensus (PoRBFTv2)

### Consensus Message Common Fields

All consensus messages include block reference for validation:

```
┌──────────────┐
│  Block Ref   │  (Which block are we forging?)
│  8 bytes     │
└──────────────┘
```

### 0x30 - consensus_generic (HTTP Compatibility Wrapper)

Similar to 0x03 (nodeCall) but for consensus methods.

**Request Payload:**
```
┌──────────────┬──────────────┬────────────────┐
│  Method Len  │  Method Name │  Params        │
│  2 bytes     │  variable    │  variable      │
└──────────────┴──────────────┴────────────────┘
```

Method names: "proposeBlockHash", "voteBlockHash", "getCommonValidatorSeed", etc.

### 0x31 - proposeBlockHash (Block Hash Proposal)

**Request Payload:**
```
┌──────────────┬──────────────┬───────────────────────────────┐
│  Block Ref   │  Block Hash  │  Validation Data               │
│  8 bytes     │  32 bytes    │  variable                     │
└──────────────┴──────────────┴───────────────────────────────┘

Validation Data:
┌──────────────┬──────────────┬──────────────┬──────────────┐
│  TX Count    │  Timestamp   │  Validator   │  Signature   │
│  2 bytes     │  8 bytes     │  variable    │  variable    │
└──────────────┴──────────────┴──────────────┴──────────────┘
```

**Response Payload:**
```
┌──────────────┬──────────────┬──────────────┬──────────────┐
│ Status Code  │  Vote        │  Our Hash    │  Signature   │
│  2 bytes     │  1 byte      │  32 bytes    │  variable    │
└──────────────┴──────────────┴──────────────┴──────────────┘
```

Vote: 0x01 = Agree, 0x00 = Disagree

### 0x32 - voteBlockHash (Vote on Proposed Hash)

**Request Payload:**
```
┌──────────────┬──────────────┬──────────────┬──────────────┐
│  Block Ref   │  Block Hash  │  Vote        │  Signature   │
│  8 bytes     │  32 bytes    │  1 byte      │  variable    │
└──────────────┴──────────────┴──────────────┴──────────────┘
```

**Response Payload:**
```
┌──────────────┬──────────────┐
│ Status Code  │  Acknowledged│
│  2 bytes     │  1 byte      │
└──────────────┴──────────────┘
```

### 0x33 - broadcastBlock (Distribute Finalized Block)

**Request Payload:**
```
┌──────────────┬────────────────┐
│  Block Ref   │  Full Block    │
│  8 bytes     │  variable      │
└──────────────┴────────────────┘
```

Full Block structure as defined in 0x25

**Response Payload:**
```
┌──────────────┬──────────────┐
│ Status Code  │  Accepted    │
│  2 bytes     │  1 byte      │
└──────────────┴──────────────┘
```

### 0x34 - getCommonValidatorSeed (CVSA Seed)

**Request Payload:**
```
┌──────────────┐
│  Block Ref   │
│  8 bytes     │
└──────────────┘
```

**Response Payload:**
```
┌──────────────┬──────────────┐
│ Status Code  │  Seed        │
│  2 bytes     │  32 bytes    │
└──────────────┴──────────────┘
```

CVSA Seed: Deterministic seed for shard member selection

### 0x35 - getValidatorTimestamp (Timestamp Collection)

**Request Payload:**
```
┌──────────────┐
│  Block Ref   │
│  8 bytes     │
└──────────────┘
```

**Response Payload:**
```
┌──────────────┬──────────────┐
│ Status Code  │  Timestamp   │
│  2 bytes     │  8 bytes     │
└──────────────┴──────────────┘
```

Used for timestamp averaging across shard members

### 0x36 - setValidatorPhase (Report Phase to Secretary)

**Request Payload:**
```
┌──────────────┬──────────────┬──────────────┐
│  Block Ref   │  Phase       │  Signature   │
│  8 bytes     │  1 byte      │  variable    │
└──────────────┴──────────────┴──────────────┘
```

Phase values:
- 0x01: Consensus loop started
- 0x02: Mempool merged
- 0x03: Block created
- 0x04: Block hash voted
- 0x05: Block finalized

**Response Payload:**
```
┌──────────────┬──────────────┐
│ Status Code  │  Acknowledged│
│  2 bytes     │  1 byte      │
└──────────────┴──────────────┘
```

### 0x37 - getValidatorPhase (Query Phase Status)

**Request Payload:**
```
┌──────────────┬──────────────┐
│  Block Ref   │  Validator   │
│  8 bytes     │  variable    │
└──────────────┴──────────────┘
```

**Response Payload:**
```
┌──────────────┬──────────────┬──────────────┐
│ Status Code  │  Phase       │  Timestamp   │
│  2 bytes     │  1 byte      │  8 bytes     │
└──────────────┴──────────────┴──────────────┘
```

### 0x38 - greenlight (Secretary Authorization)

**Request Payload:**
```
┌──────────────┬──────────────┬──────────────┐
│  Block Ref   │  Phase       │  Timestamp   │
│  8 bytes     │  1 byte      │  8 bytes     │
└──────────────┴──────────────┴──────────────┘
```

**Response Payload:**
```
┌──────────────┬──────────────┐
│ Status Code  │  Can Proceed │
│  2 bytes     │  1 byte      │
└──────────────┴──────────────┘
```

### 0x39 - getBlockTimestamp (Query Block Timestamp)

**Request Payload:**
```
┌──────────────┐
│  Block Ref   │
│  8 bytes     │
└──────────────┘
```

**Response Payload:**
```
┌──────────────┬──────────────┐
│ Status Code  │  Timestamp   │
│  2 bytes     │  8 bytes     │
└──────────────┴──────────────┘
```

### 0x3A - validatorStatusSync (Validator Status)

**Request Payload:**
```
┌──────────────┬──────────────┬──────────────┐
│  Block Ref   │  Status      │  Sync Data   │
│  8 bytes     │  1 byte      │  variable    │
└──────────────┴──────────────┴──────────────┘
```

Status: 0x01=Online, 0x02=Syncing, 0x03=Behind

**Response Payload:**
```
┌──────────────┬──────────────┐
│ Status Code  │  Acknowledged│
│  2 bytes     │  1 byte      │
└──────────────┴──────────────┘
```

---

## Category 0x4X - GCR Operations

### GCR Common Structure

GCR operations work with key-value identity mappings.

### 0x40 - gcr_generic (HTTP Compatibility Wrapper)

Similar to 0x03 and 0x30 for GCR methods.

### 0x41 - gcr_identityAssign (Infer Identity)

**Request Payload:**
```
┌──────────────┬──────────────┬──────────────┐
│  Address Len │  Address     │  Operation   │
│  2 bytes     │  variable    │  variable    │
└──────────────┴──────────────┴──────────────┘
```

**Response Payload:**
```
┌──────────────┬──────────────┬──────────────┐
│ Status Code  │  Identity    │  Assigned    │
│  2 bytes     │  variable    │  1 byte      │
└──────────────┴──────────────┴──────────────┘
```

### 0x42 - gcr_getIdentities (Get All Identities)

**Request Payload:**
```
┌──────────────┬──────────────┐
│  Address Len │  Address     │
│  2 bytes     │  variable    │
└──────────────┴──────────────┘
```

**Response Payload:**
```
┌──────────────┬──────────────┬────────────────────────────┐
│ Status Code  │  ID Count    │  Identity Array            │
│  2 bytes     │  2 bytes     │  variable                  │
└──────────────┴──────────────┴────────────────────────────┘

Each Identity:
┌──────────────┬──────────────┬──────────────┬──────────────┐
│  Type        │  Key Length  │  Key         │  Value Len   │
│  1 byte      │  2 bytes     │  variable    │  2 bytes     │
└──────────────┴──────────────┴──────────────┴──────────────┘
```

Type: 0x01=Web2, 0x02=Crosschain, 0x03=Native, 0x04=Other

### 0x43 - gcr_getWeb2Identities (Web2 Only)

**Request/Response**: Same as 0x42 but filtered to Type=0x01

### 0x44 - gcr_getXmIdentities (Crosschain Only)

**Request/Response**: Same as 0x42 but filtered to Type=0x02

### 0x45 - gcr_getPoints (Get Incentive Points)

**Request Payload:**
```
┌──────────────┬──────────────┐
│  Address Len │  Address     │
│  2 bytes     │  variable    │
└──────────────┴──────────────┘
```

**Response Payload:**
```
┌──────────────┬──────────────┬──────────────┐
│ Status Code  │  Total Points│  Breakdown   │
│  2 bytes     │  8 bytes     │  variable    │
└──────────────┴──────────────┴──────────────┘

Breakdown (optional):
┌──────────────┬────────────────────────────┐
│  Category Cnt│  [Category][Points]...     │
│  2 bytes     │  variable                  │
└──────────────┴────────────────────────────┘
```

### 0x46 - gcr_getTopAccounts (Leaderboard)

**Request Payload:**
```
┌──────────────┬──────────────┐
│  Max Count   │  Offset      │
│  2 bytes     │  2 bytes     │
└──────────────┴──────────────┘
```

**Response Payload:**
```
┌──────────────┬──────────────┬────────────────────────────┐
│ Status Code  │  Account Cnt │  Account Array             │
│  2 bytes     │  2 bytes     │  variable                  │
└──────────────┴──────────────┴────────────────────────────┘

Each Account:
┌──────────────┬──────────────┬──────────────┐
│  Address Len │  Address     │  Points      │
│  2 bytes     │  variable    │  8 bytes     │
└──────────────┴──────────────┴──────────────┘
```

### 0x47 - gcr_getReferralInfo (Referral Lookup)

**Request Payload:**
```
┌──────────────┬──────────────┐
│  Address Len │  Address     │
│  2 bytes     │  variable    │
└──────────────┴──────────────┘
```

**Response Payload:**
```
┌──────────────┬──────────────┬──────────────┬──────────────┐
│ Status Code  │  Referrer    │  Referee Cnt │  Bonuses     │
│  2 bytes     │  variable    │  2 bytes     │  variable    │
└──────────────┴──────────────┴──────────────┴──────────────┘
```

### 0x48 - gcr_validateReferral (Validate Code)

**Request Payload:**
```
┌──────────────┬──────────────┐
│  Code Length │  Ref Code    │
│  2 bytes     │  variable    │
└──────────────┴──────────────┘
```

**Response Payload:**
```
┌──────────────┬──────────────┬──────────────┐
│ Status Code  │  Valid       │  Referrer    │
│  2 bytes     │  1 byte      │  variable    │
└──────────────┴──────────────┴──────────────┘
```

### 0x49 - gcr_getAccountByIdentity (Identity Lookup)

**Request Payload:**
```
┌──────────────┬──────────────┬──────────────┐
│  Type        │  Key Length  │  Key         │
│  1 byte      │  2 bytes     │  variable    │
└──────────────┴──────────────┴──────────────┘
```

**Response Payload:**
```
┌──────────────┬──────────────┬──────────────┐
│ Status Code  │  Address Len │  Address     │
│  2 bytes     │  2 bytes     │  variable    │
└──────────────┴──────────────┴──────────────┘
```

### 0x4A - gcr_getAddressInfo (Full Address State)

**Request Payload:**
```
┌──────────────┬──────────────┐
│  Address Len │  Address     │
│  2 bytes     │  variable    │
└──────────────┴──────────────┘
```

**Response Payload:**
```
┌─────────────────────────────────────────────────────────────┐
│ Status Code (2 bytes)                                        │
├─────────────────────────────────────────────────────────────┤
│ Balance (8 bytes, uint64)                                    │
├─────────────────────────────────────────────────────────────┤
│ Nonce (8 bytes, uint64)                                      │
├─────────────────────────────────────────────────────────────┤
│ Identities Count (2 bytes)                                   │
│   [Identity Array as in 0x42]                                │
├─────────────────────────────────────────────────────────────┤
│ Points (8 bytes, uint64)                                     │
├─────────────────────────────────────────────────────────────┤
│ Additional Data Length (2 bytes)                             │
│ Additional Data (variable, JSON-encoded state)               │
└─────────────────────────────────────────────────────────────┘
```

### 0x4B - gcr_getAddressNonce (Nonce Only)

**Request Payload:**
```
┌──────────────┬──────────────┐
│  Address Len │  Address     │
│  2 bytes     │  variable    │
└──────────────┴──────────────┘
```

**Response Payload:**
```
┌──────────────┬──────────────┐
│ Status Code  │  Nonce       │
│  2 bytes     │  8 bytes     │
└──────────────┴──────────────┘
```

---

## Category 0x5X - Browser/Client Communication

### 0x50 - login_request (Browser Login Initiation)

**Request Payload:**
```
┌──────────────┬──────────────┬──────────────┬──────────────┐
│  Client Type │  Challenge   │  Public Key  │  Metadata    │
│  1 byte      │  32 bytes    │  variable    │  variable    │
└──────────────┴──────────────┴──────────────┴──────────────┘
```

Client Type: 0x01=Web, 0x02=Mobile, 0x03=Desktop

**Response Payload:**
```
┌──────────────┬──────────────┬──────────────┐
│ Status Code  │  Session ID  │  Signature   │
│  2 bytes     │  16 bytes    │  variable    │
└──────────────┴──────────────┴──────────────┘
```

### 0x51 - login_response (Browser Login Completion)

**Request Payload:**
```
┌──────────────┬──────────────┬──────────────┐
│  Session ID  │  Signed Chal │  Client Info │
│  16 bytes    │  variable    │  variable    │
└──────────────┴──────────────┴──────────────┘
```

**Response Payload:**
```
┌──────────────┬──────────────┬──────────────┐
│ Status Code  │  Auth Token  │  Expiry      │
│  2 bytes     │  variable    │  8 bytes     │
└──────────────┴──────────────┴──────────────┘
```

### 0x52 - web2ProxyRequest (Web2 Proxy)

**Request Payload:**
```
┌──────────────┬──────────────┬──────────────┬──────────────┐
│  Service Type│  Endpoint Len│  Endpoint    │  Params      │
│  1 byte      │  2 bytes     │  variable    │  variable    │
└──────────────┴──────────────┴──────────────┴──────────────┘
```

Service Type: 0x01=Twitter, 0x02=Discord, 0x03=GitHub, 0x04=Generic

**Response Payload:**
```
┌──────────────┬──────────────┬──────────────┐
│ Status Code  │  Data Length │  Data        │
│  2 bytes     │  4 bytes     │  variable    │
└──────────────┴──────────────┴──────────────┘
```

### 0x53 - getTweet (Fetch Tweet)

**Request Payload:**
```
┌──────────────┬──────────────┐
│  Tweet ID Len│  Tweet ID    │
│  2 bytes     │  variable    │
└──────────────┴──────────────┘
```

**Response Payload:**
```
┌──────────────┬──────────────┬──────────────┬──────────────┐
│ Status Code  │  Author      │  Content     │  Metadata    │
│  2 bytes     │  variable    │  variable    │  variable    │
└──────────────┴──────────────┴──────────────┴──────────────┘
```

### 0x54 - getDiscordMessage (Fetch Discord Message)

**Request Payload:**
```
┌──────────────┬──────────────┬──────────────┬──────────────┐
│  Channel ID  │  Message ID  │  Guild ID    │  Auth Token  │
│  8 bytes     │  8 bytes     │  8 bytes     │  variable    │
└──────────────┴──────────────┴──────────────┴──────────────┘
```

**Response Payload:**
```
┌──────────────┬──────────────┬──────────────┬──────────────┐
│ Status Code  │  Author      │  Content     │  Timestamp   │
│  2 bytes     │  variable    │  variable    │  8 bytes     │
└──────────────┴──────────────┴──────────────┴──────────────┘
```

---

## Category 0x6X - Admin Operations

**Security Note**: All admin operations require SUDO_PUBKEY verification

### 0x60 - admin_rateLimitUnblock (Unblock IP)

**Request Payload:**
```
┌──────────────┬──────────────┬──────────────┐
│  IP Type     │  IP Length   │  IP Address  │
│  1 byte      │  2 bytes     │  variable    │
└──────────────┴──────────────┴──────────────┘
```

IP Type: 0x01=IPv4, 0x02=IPv6

**Response Payload:**
```
┌──────────────┬──────────────┐
│ Status Code  │  Unblocked   │
│  2 bytes     │  1 byte      │
└──────────────┴──────────────┘
```

### 0x61 - admin_getCampaignData (Campaign Data)

**Request Payload:**
```
┌──────────────┬──────────────┐
│  Campaign ID │  Data Type   │
│  16 bytes    │  1 byte      │
└──────────────┴──────────────┘
```

Data Type: 0x01=Stats, 0x02=Participants, 0x03=Full

**Response Payload:**
```
┌──────────────┬──────────────┬──────────────┐
│ Status Code  │  Data Length │  Data        │
│  2 bytes     │  4 bytes     │  variable    │
└──────────────┴──────────────┴──────────────┘
```

### 0x62 - admin_awardPoints (Manual Points Award)

**Request Payload:**
```
┌──────────────┬──────────────┬──────────────┬──────────────┐
│  Address Len │  Address     │  Points      │  Reason Len  │
│  2 bytes     │  variable    │  8 bytes     │  2 bytes     │
└──────────────┴──────────────┴──────────────┴──────────────┘
┌──────────────┐
│  Reason      │
│  variable    │
└──────────────┘
```

**Response Payload:**
```
┌──────────────┬──────────────┬──────────────┐
│ Status Code  │  New Total   │  TX Hash     │
│  2 bytes     │  8 bytes     │  32 bytes    │
└──────────────┴──────────────┴──────────────┘
```

---

## Category 0xFX - Protocol Meta

### 0xF0 - proto_versionNegotiate (Version Negotiation)

**Request Payload:**
```
┌──────────────┬──────────────┬────────────────────────────┐
│  Min Version │  Max Version │  Supported Versions Array  │
│  2 bytes     │  2 bytes     │  variable                  │
└──────────────┴──────────────┴────────────────────────────┘

Supported Versions:
┌──────────────┬────────────────────────────┐
│  Count       │  [Version 1][Version 2]... │
│  2 bytes     │  2 bytes each              │
└──────────────┴────────────────────────────┘
```

**Response Payload:**
```
┌──────────────┬──────────────┐
│ Status Code  │  Negotiated  │
│  2 bytes     │  2 bytes     │
└──────────────┴──────────────┘
```

### 0xF1 - proto_capabilityExchange (Capability Exchange)

**Request Payload:**
```
┌──────────────┬────────────────────────────┐
│  Feature Cnt │  Feature Array             │
│  2 bytes     │  variable                  │
└──────────────┴────────────────────────────┘

Each Feature:
┌──────────────┬──────────────┬──────────────┐
│  Feature ID  │  Version     │  Enabled     │
│  2 bytes     │  2 bytes     │  1 byte      │
└──────────────┴──────────────┴──────────────┘
```

Feature IDs: 0x0001=Compression, 0x0002=Encryption, 0x0003=Batching, etc.

**Response Payload:**
```
┌──────────────┬──────────────┬────────────────────────────┐
│ Status Code  │  Feature Cnt │  Supported Features        │
│  2 bytes     │  2 bytes     │  variable                  │
└──────────────┴──────────────┴────────────────────────────┘
```

### 0xF2 - proto_error (Protocol Error)

**Payload (Fire-and-forget):**
```
┌──────────────┬──────────────┬──────────────┐
│  Error Code  │  Msg Length  │  Message     │
│  2 bytes     │  2 bytes     │  variable    │
└──────────────┴──────────────┴──────────────┘
```

Error Codes:
- 0x0001: Invalid message format
- 0x0002: Authentication failed
- 0x0003: Unsupported protocol version
- 0x0004: Invalid opcode
- 0x0005: Payload too large
- 0x0006: Rate limit exceeded

**No response** (fire-and-forget)

### 0xF3 - proto_ping (Protocol Keepalive)

**Request Payload:**
```
┌──────────────┐
│  Timestamp   │
│  8 bytes     │
└──────────────┘
```

**Response Payload:**
```
┌──────────────┬──────────────┐
│ Status Code  │  Timestamp   │
│  2 bytes     │  8 bytes     │
└──────────────┴──────────────┘
```

**Note**: Different from 0x00 (application ping). This is protocol-level keepalive.

### 0xF4 - proto_disconnect (Graceful Disconnect)

**Payload (Fire-and-forget):**
```
┌──────────────┬──────────────┬──────────────┐
│  Reason Code │  Msg Length  │  Message     │
│  1 byte      │  2 bytes     │  variable    │
└──────────────┴──────────────┴──────────────┘
```

Reason Codes:
- 0x00: Idle timeout
- 0x01: Shutdown
- 0x02: Switching protocols
- 0x03: Connection error
- 0xFF: Other

**No response** (fire-and-forget)

---

## Bandwidth Savings Summary

| Category | Typical HTTP Size | OmniProtocol Size | Savings |
|----------|-------------------|-------------------|---------|
| Control (ping) | ~200 bytes | 12 bytes | 94% |
| Control (hello_peer) | ~800 bytes | ~265 bytes | 67% |
| Transaction (execute) | ~700 bytes | ~300 bytes | 57% |
| Consensus (propose) | ~600 bytes | ~150 bytes | 75% |
| Sync (mempool) | ~5 KB | ~1.5 KB | 70% |
| GCR (getIdentities) | ~1 KB | ~400 bytes | 60% |
| Block (full) | ~50 KB | ~20 KB | 60% |

**Overall Average**: ~60-90% bandwidth reduction across all message types

---

## Implementation Notes

### Endianness

**All multi-byte integers use big-endian (network byte order)**:
```typescript
// Writing
buffer.writeUInt16BE(value, offset)
buffer.writeUInt32BE(value, offset)
buffer.writeUInt64BE(value, offset)

// Reading
const value = buffer.readUInt16BE(offset)
```

### String Encoding

**All strings are UTF-8 with 2-byte length prefix**:
```typescript
// Writing
const bytes = Buffer.from(str, 'utf8')
buffer.writeUInt16BE(bytes.length, offset)
bytes.copy(buffer, offset + 2)

// Reading
const length = buffer.readUInt16BE(offset)
const str = buffer.toString('utf8', offset + 2, offset + 2 + length)
```

### Hash Encoding

**All hashes are raw 32-byte binary (not hex strings)**:
```typescript
// Convert hex hash to binary
const hash = Buffer.from(hexHash, 'hex')  // 32 bytes

// Convert binary to hex (for display)
const hexHash = hash.toString('hex')
```

### Array Encoding

**All arrays use 2-byte count followed by elements**:
```typescript
// Writing
buffer.writeUInt16BE(array.length, offset)
for (const element of array) {
    // Write element
}

// Reading
const count = buffer.readUInt16BE(offset)
const array = []
for (let i = 0; i < count; i++) {
    // Read element
}
```

### Optional Fields

**Use length=0 for optional empty fields**:
```
Optional String:
  - Length: 0x00 0x00 (0 bytes)
  - No data follows

Optional Bytes:
  - Length: 0x00 0x00 (0 bytes)
  - No data follows
```

### Validation

**Every payload parser should validate**:
1. Buffer length matches expected size
2. String lengths don't exceed buffer bounds
3. Array counts are reasonable (<65,535 elements)
4. Enum values are within defined ranges
5. Required fields are non-empty

### Error Handling

**On malformed payload**:
1. Log error with context (opcode, peer, buffer dump)
2. Send proto_error (0xF2) with error code
3. Close connection if protocol violation
4. Do not process partial data

---

## Next Steps

**Step 6**: Module Structure & Interfaces
- TypeScript interfaces for all payload types
- Serialization/deserialization utilities
- Integration with existing Peer/PeerManager
- OmniProtocol module organization

**Step 7**: Phased Implementation Plan
- Unit testing strategy for each opcode
- Load testing approach
- Dual HTTP/TCP migration phases
- Rollback capability and monitoring

---

## Summary

Step 5 defines binary payload structures for all 9 opcode categories:

✅ **Control (0x0X)**: ping, hello_peer, nodeCall, getPeerlist
✅ **Transactions (0x1X)**: execute, bridge operations, confirm, broadcast
✅ **Sync (0x2X)**: mempool, peerlist, block sync operations
✅ **Consensus (0x3X)**: PoRBFTv2 messages (propose, vote, CVSA, secretary)
✅ **GCR (0x4X)**: Identity operations, points queries, leaderboard
✅ **Browser (0x5X)**: Login, web2 proxy, social media fetching
✅ **Admin (0x6X)**: Rate limit, campaign data, points award
✅ **Protocol Meta (0xFX)**: Version negotiation, capability exchange, errors

**Key Achievements:**
- Complete binary encoding for all HTTP functionality
- 60-90% bandwidth reduction vs HTTP/JSON
- Maintains backward compatibility semantics
- Efficient encoding with length-prefixed strings
- Big-endian integers for network byte order
- Comprehensive validation guidelines
