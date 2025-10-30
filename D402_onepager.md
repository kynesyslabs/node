
## x402d

### System Components

```
┌─────────────────────────────────────────────────────────────┐
│                     D402 Architecture                        │
└─────────────────────────────────────────────────────────────┘

┌──────────────┐        ┌──────────────┐        ┌──────────────┐
│   Client     │        │   Service    │        │  Demos Node  │
│  (Buyer)     │        │  (Seller)    │        │ (Facilitator)│
└──────────────┘        └──────────────┘        └──────────────┘
       │                       │                       │
       │                       │                       │
       │  1. Service Request   │                       │
       │──────────────────────>│                       │
       │                       │                       │
       │  2. HTTP 402 Response │                       │
       │<──────────────────────│                       │
       │  (Payment Required)   │                       │
       │                       │                       │
       │  3. Create Payment    │                       │
       │  (Sign with Ed25519)  │                       │
       │                       │                       │
       │  4. Service Request   │                       │
       │  + Payment Payload    │                       │
       │──────────────────────>│                       │
       │                       │                       │
       │                       │  5. Verify Payment    │
       │                       │──────────────────────>│
       │                       │                       │
       │                       │  6. Verification      │
       │                       │     Response          │
       │                       │<──────────────────────│
       │                       │  (valid/invalid)      │
       │                       │                       │
       │                       │  7. Settle Payment    │
       │                       │──────────────────────>│
       │                       │                       │
       │                       │  8. Settlement        │
       │                       │     Response          │
       │                       │<──────────────────────│
       │                       │  (txHash + block)     │
       │                       │                       │
       │  9. Service Response  │                       │
       │<──────────────────────│                       │
       │  (Content Delivered)  │                       │
       │                       │                       │
```

### Component Responsibilities

**Client (Buyer)**:

- Creates payment transactions
- Signs transactions with Ed25519 private key
- Includes payment proof in service requests
- Uses Demos SDK D402 client library

**Service (Seller)**:

- Returns HTTP 402 with payment requirements
- Validates payment proofs via facilitator
- Requests settlement after successful validation
- Delivers content upon settlement confirmation

**Facilitator (Demos Node)**:

- Verifies transaction signatures
- Checks sender balances in GCR
- Validates transaction structure and nonces
- Executes settlement via Transaction objects in the Mempool
- Returns settlement receipts

### Network Architecture

- **Primary Network**: Demos Network mainnet
- **Token**: DEM (native blockchain token)
- **Consensus**: PoR (Proof of Representation) BFT
- **State Management**: GCR (Global Change Registry)
- **Balance Storage**: Blockchain Native GCR tables
- **Finality**: Fast finality
