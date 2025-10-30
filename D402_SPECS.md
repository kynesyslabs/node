# D402 HTTP Payment Protocol - Technical Specification

## Current Status: Phase 3 Complete (2025-01-31)

Phases 1-3 implemented: Server SDK, Client SDK, and middleware are complete and building successfully.

---

## Architecture Overview

D402 implements the HTTP 402 Payment Required pattern for Demos Network, enabling dApps to gate content behind payments and clients to automatically handle payment flows.

### Three-Layer Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         D402 PROTOCOL FLOW                          │
└─────────────────────────────────────────────────────────────────────┘

┌──────────────┐                ┌──────────────┐                ┌──────────────┐
│   CLIENT     │                │  DAPP SERVER │                │  NODE RPC    │
│   (Buyer)    │                │   (Seller)   │                │ (Facilitator)│
└──────┬───────┘                └──────┬───────┘                └──────┬───────┘
       │                               │                               │
       │  1. GET /premium-content      │                               │
       │──────────────────────────────>│                               │
       │                               │                               │
       │  2. 402 Payment Required      │                               │
       │     {amount, recipient,       │                               │
       │      resourceId}               │                               │
       │<──────────────────────────────│                               │
       │                               │                               │
       │  3. Create d402_payment       │                               │
       │     with memo:                │                               │
       │     "resourceId:xyz"          │                               │
       │                               │                               │
       │  4. Sign transaction          │                               │
       │     (Ed25519)                 │                               │
       │                               │                               │
       │  5. POST /d402/settle         │                               │
       │     {transaction}             │                               │
       │───────────────────────────────────────────────────────────────>│
       │                               │                               │
       │  6. Verify & Settle           │                               │
       │     - Check signature         │                               │
       │     - Update GCR balances     │                               │
       │<───────────────────────────────────────────────────────────────│
       │     {success, hash, block}    │                               │
       │                               │                               │
       │  7. Retry GET /premium        │                               │
       │     X-Payment-Proof: txhash   │                               │
       │──────────────────────────────>│                               │
       │                               │                               │
       │                               │  8. POST /d402/verify         │
       │                               │     {txHash}                  │
       │                               │──────────────────────────────>│
       │                               │                               │
       │                               │  9. Verification Result       │
       │                               │<──────────────────────────────│
       │                               │     {valid, from, to,         │
       │                               │      amount, memo}            │
       │                               │                               │
       │                               │ 10. Validate payment:         │
       │                               │     - recipient matches       │
       │                               │     - amount sufficient       │
       │                               │     - resourceId in memo      │
       │                               │                               │
       │ 11. 200 OK + Content          │                               │
       │<──────────────────────────────│                               │
       │                               │                               │
```

---

## Component Details

### 1. Client SDK (D402Client)

**Location:** `../sdks/src/d402/client/`

**Responsibilities:**
- Detect 402 responses from servers
- Create d402_payment transactions from payment requirements
- Sign and broadcast payments to RPC
- Retry requests with payment proof headers

**Key Methods:**
```typescript
class D402Client {
  // Create unsigned d402_payment from 402 requirements
  async createPayment(requirement: D402PaymentRequirement): Promise<Transaction>

  // Sign and broadcast payment to RPC
  async settle(payment: Transaction): Promise<D402SettlementResult>

  // Complete flow: payment + retry
  async handlePaymentRequired(
    requirement: D402PaymentRequirement,
    url: string,
    requestInit?: RequestInit
  ): Promise<Response>
}
```

**Usage:**
```typescript
import { D402Client } from '@kynesyslabs/demosdk/d402/client'

const d402 = new D402Client(demosInstance)
const response = await fetch('/premium')

if (response.status === 402) {
  const requirement = await response.json()
  const finalResponse = await d402.handlePaymentRequired(
    requirement,
    '/premium',
    { method: 'GET' }
  )
}
```

---

### 2. Server SDK (D402Server + Middleware)

**Location:** `../sdks/src/d402/server/`

**Responsibilities:**
- Verify payment proofs via RPC facilitator
- Generate 402 responses with payment requirements
- Validate payments match requirements
- Cache verified payments with configurable TTL

**Key Components:**

**D402Server Class:**
```typescript
class D402Server {
  // Verify payment via RPC
  async verify(txHash: string): Promise<D402VerificationResult>

  // Generate 402 response data
  require(requirement: D402PaymentRequirement): { status: 402, body: ... }

  // Validate payment matches requirements
  validatePayment(
    verification: D402VerificationResult,
    requirement: D402PaymentRequirement
  ): boolean
}
```

**Express Middleware:**
```typescript
function d402Required(options: D402MiddlewareOptions) {
  return async (req, res, next) => {
    // Check X-Payment-Proof header
    // If missing → return 402
    // If present → verify + validate → call next()
  }
}
```

**Usage:**
```typescript
import { d402Required } from '@kynesyslabs/demosdk/d402/server'

app.get('/premium-article',
  d402Required({
    amount: 5000000000000000000,  // 5 DEM
    resourceId: 'article-123',
    rpcUrl: 'https://node2.demos.sh',
    recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb'
  }),
  (req, res) => {
    res.json({
      article: "Premium content",
      paidBy: req.d402Payment.from
    })
  }
)
```

---

### 3. Node RPC (Facilitator Endpoints)

**Location:** Already implemented in `../node/`

**Endpoints:**

**GET /d402/health**
- Health check for D402 facilitator
- Returns: `{ status: "ok", protocol: "d402", version: "1.0" }`

**GET /d402/nonce/:address**
- Get current nonce for address
- Used by client to create transactions
- Returns: `{ address, nonce }`

**POST /d402/verify**
- Verify a payment transaction
- Input: `{ txHash: string }`
- Returns: `{ valid, verified_from, verified_to, verified_amount, verified_memo }`
- Used by: dApp servers

**POST /d402/settle**
- Settle a payment transaction
- Input: `{ transaction: SignedTransaction }`
- Returns: `{ success, hash, blockNumber }`
- Used by: Clients

---

## Data Flow & Formats

### Payment Requirement (402 Response)
```typescript
interface D402PaymentRequirement {
  amount: number          // DEM in atomic units
  recipient: string       // Merchant Demos address
  resourceId: string      // Resource identifier
  description?: string    // Optional description
}
```

### Payment Transaction Format
```typescript
{
  content: {
    type: "d402_payment",
    nonce: number,
    timestamp: number,
    data: [
      "d402_payment",
      {
        to: "0x742d35Cc...",
        amount: 5000000000000000000,
        memo: "resourceId:article-123 - Premium Article"
      }
    ]
  },
  signature: {
    algorithm: "ed25519",
    publicKey: "hex...",
    data: "hex..."
  },
  hash: "0xABC..."
}
```

### Verification Result
```typescript
interface D402VerificationResult {
  valid: boolean
  verified_from?: string    // Sender address
  verified_to?: string      // Recipient address
  verified_amount?: number  // Payment amount
  verified_memo?: string    // Transaction memo
  timestamp: number
}
```

### Settlement Result
```typescript
interface D402SettlementResult {
  success: boolean
  hash: string
  blockNumber?: number
  message?: string
}
```

---

## Key Design Decisions

### 1. Payment Proof Format
**Decision:** Transaction hash only
**Rationale:** Simple, clean, allows server-side caching

### 2. Payment Validation
**Decision:** Server validates after payment
**Rationale:** Full server control, flexible validation logic

### 3. Resource Mapping
**Decision:** `resourceId:xyz` in memo field
**Rationale:** Simple, safe (server validates before serving), extensible

### 4. Payment Reuse
**Decision:** Time-based with configurable TTL (default 5 minutes)
**Rationale:** Prevents abuse, allows retries, server-controlled

### 5. SDK Organization
**Decision:** Separate `d402/server` and `d402/client` exports
**Rationale:** Clear separation, tree-shaking friendly, organized

---

## Security Considerations

### Transaction Security
- **Ed25519 Signatures:** All payments cryptographically signed
- **Nonce Management:** Prevents replay attacks
- **Amount Validation:** Server validates exact amounts
- **Recipient Validation:** Server ensures payment to correct address

### Cache Security
- **TTL-based Expiry:** Payments expire after configurable time
- **Memo Validation:** Resource ID must match in memo
- **Server-side Validation:** All validation happens server-side

### Network Security
- **HTTPS Required:** All communication over TLS
- **Payment Proof in Headers:** Not exposed in URLs
- **RPC Authentication:** Facilitator endpoints can require auth

---

## Performance Characteristics

### Typical Latency
- **Payment Creation:** <50ms (client-side)
- **Payment Signature:** <100ms (Ed25519)
- **RPC Settlement:** 1-2 seconds (consensus)
- **Payment Verification:** <100ms (with cache)
- **Total Flow:** ~2-3 seconds

### Scalability
- **Payment Cache:** Reduces RPC load
- **Stateless Verification:** Horizontally scalable
- **No External Dependencies:** No third-party bottlenecks

---

## Implementation Status

### ✅ Completed (Phases 1-3)
- D402 transaction type in SDK types
- Gasless transaction support
- D402Server class with verification logic
- Express middleware (d402Required)
- D402Client class with payment creation
- Build system configuration
- TypeScript type definitions

### 🔄 In Progress (Phase 4)
- Package.json exports configuration
- Module resolution testing

### ⏳ Pending (Phases 5-6)
- Documentation updates
- Example applications
- Integration guides

---

## Package Exports

**After Phase 4 completion:**

```typescript
// Server-side usage
import {
  D402Server,
  d402Required
} from '@kynesyslabs/demosdk/d402/server'

// Client-side usage
import {
  D402Client
} from '@kynesyslabs/demosdk/d402/client'

// Type imports
import type {
  D402PaymentRequirement,
  D402SettlementResult
} from '@kynesyslabs/demosdk/d402/client'
```

---

## Future Enhancements

### Planned Features
- **relayTx Method:** Allow apps to relay signed transactions
  - Current: Client signs → Client broadcasts → App verifies
  - Future: Client signs → App receives → App relays → RPC settles

### Potential Extensions
- Subscription payments (recurring)
- Batch payments (multiple resources)
- Payment channels (off-chain micro-payments)
- Multi-token support

---

## Related Documentation

- **Phase Plan:** `D402_HTTP_PHASES.md` - Implementation roadmap
- **Node Spec:** `D402_SPEC.md` - Original D402 protocol specification (gasless payments)
- **SDK Types:** `../sdks/src/types/blockchain/TransactionSubtypes/D402PaymentTransaction.ts`
- **GitBook Docs:** `../documentation/` - User-facing documentation

---

## Quick Reference

### Minimal Client Example
```typescript
const d402 = new D402Client(demos)
const payment = await d402.createPayment({ amount, recipient, resourceId })
const result = await d402.settle(payment)
```

### Minimal Server Example
```typescript
app.get('/paid-route',
  d402Required({ amount: 5e18, resourceId: 'xyz', rpcUrl }),
  (req, res) => res.json({ data: "premium" })
)
```

### Payment Flow Headers
```http
# Request without payment
GET /premium HTTP/1.1
Host: example.com

# 402 Response
HTTP/1.1 402 Payment Required
Content-Type: application/json
{"amount":5000000000000000000,"recipient":"0x...","resourceId":"xyz"}

# Retry with payment
GET /premium HTTP/1.1
Host: example.com
X-Payment-Proof: 0xABC123...

# Success
HTTP/1.1 200 OK
Content-Type: application/json
{"content":"Premium data"}
```

---

**Last Updated:** 2025-01-31
**Current Phase:** 4 (Build & Exports)
**Next Milestone:** Package.json exports configuration
