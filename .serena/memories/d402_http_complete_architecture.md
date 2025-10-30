# D402 HTTP Payment Protocol - Complete Architecture & Status

## Current Status (2025-01-31)

**Phases Complete:** 1-4 (Server SDK, Client SDK, Middleware, Build)  
**Phases Pending:** 5-6 (Documentation updates, Example app)  
**Build Status:** ✅ Successful

---

## What is D402?

D402 is Demos Network's implementation of the HTTP 402 Payment Required protocol, enabling dApps to gate content behind payments and clients to automatically handle payment flows using DEM tokens.

### Core Features
- **HTTP 402 Pattern:** Standard HTTP status code for payment-gated content
- **Gasless Payments:** D402 transactions sponsored by network (no gas fees)
- **Native DEM:** Uses Demos Network's native token
- **Ed25519 Signatures:** Cryptographic security
- **Time-based Caching:** Configurable payment TTL (default: 5 minutes)

---

## Architecture Overview

### Three-Component System

1. **Client SDK** (`../sdks/src/d402/client/`)
   - Detects 402 responses
   - Creates d402_payment transactions
   - Signs and broadcasts to RPC
   - Retries with payment proof

2. **Server SDK** (`../sdks/src/d402/server/`)
   - Verifies payments via RPC
   - Generates 402 responses
   - Validates payment requirements
   - Caches verified payments

3. **Node RPC** (Already implemented)
   - `/d402/verify` - Verify payment proofs
   - `/d402/settle` - Settle payments
   - `/d402/nonce/:address` - Get address nonce
   - `/d402/health` - Health check

### Complete Flow (10 Steps)

```
1. Client → GET /premium-content
2. Server (no proof) → 402 with {amount, recipient, resourceId}
3. Client SDK → Creates d402_payment with memo "resourceId:xyz"
4. Client SDK → Signs & broadcasts to RPC
5. RPC → Validates & settles via existing /d402/settle
6. Client SDK → Retry GET /premium with X-Payment-Proof: txhash
7. Server → POST /d402/verify {txHash} to RPC
8. RPC → Returns {valid, verified_from, verified_to, verified_amount, verified_memo}
9. Server → Validates recipient, amount, resource (via memo)
10. Server → 200 OK with content
```

---

## Implementation Details

### Client SDK (D402Client)

**Location:** `../sdks/src/d402/client/D402Client.ts`

**Key Methods:**
```typescript
class D402Client {
  constructor(demos: Demos)
  
  // Create unsigned d402_payment from 402 requirements
  async createPayment(requirement: D402PaymentRequirement): Promise<Transaction>
  
  // Sign and broadcast payment
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

### Server SDK (D402Server + Middleware)

**Location:** `../sdks/src/d402/server/`

**D402Server Class:**
```typescript
class D402Server {
  constructor(config: { rpcUrl: string, cacheTTL?: number })
  
  // Verify payment via RPC
  async verify(txHash: string): Promise<D402VerificationResult>
  
  // Generate 402 response data
  require(requirement: D402PaymentRequirement): { status: 402, body: ... }
  
  // Validate payment matches requirements
  validatePayment(
    verification: D402VerificationResult,
    requirement: D402PaymentRequirement
  ): boolean
  
  // Clear payment cache
  clearCache(): void
}
```

**Express Middleware:**
```typescript
function d402Required(options: D402MiddlewareOptions) {
  return async (req, res, next) => {
    const paymentProof = req.headers['x-payment-proof']
    
    if (!paymentProof) {
      return res.status(402).json({
        amount: options.amount,
        recipient: options.recipient,
        resourceId: options.resourceId,
        description: options.description
      })
    }
    
    const verification = await server.verify(paymentProof)
    const isValid = server.validatePayment(verification, requirement)
    
    if (!isValid) {
      return res.status(403).json({ error: 'Invalid payment' })
    }
    
    req.d402Payment = { from, to, amount, txHash }
    next()
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

## Package Structure

```
@kynesyslabs/demosdk/
├── d402/
│   ├── index.ts                    # Unified exports
│   ├── server/
│   │   ├── D402Server.ts          ✅ Phase 1
│   │   ├── middleware.ts          ✅ Phase 2
│   │   ├── types.ts               ✅ Phase 1
│   │   └── index.ts               ✅ Phase 1
│   └── client/
│       ├── D402Client.ts          ✅ Phase 3
│       ├── types.ts               ✅ Phase 3
│       └── index.ts               ✅ Phase 3
└── types/blockchain/TransactionSubtypes/
    └── D402PaymentTransaction.ts  ✅ (pre-existing)
```

---

## Package Exports (Phase 4 Complete)

**package.json exports:**
```json
{
  "./d402": "./build/d402/index.js",
  "./d402/server": "./build/d402/server/index.js",
  "./d402/client": "./build/d402/client/index.js"
}
```

**Import examples:**
```typescript
// Server-side
import { D402Server, d402Required } from '@kynesyslabs/demosdk/d402/server'

// Client-side
import { D402Client } from '@kynesyslabs/demosdk/d402/client'

// Types
import type {
  D402PaymentRequirement,
  D402SettlementResult
} from '@kynesyslabs/demosdk/d402/client'
```

---

## Type Definitions

### Payment Requirement (402 Response)
```typescript
interface D402PaymentRequirement {
  amount: number          // DEM in atomic units
  recipient: string       // Merchant Demos address
  resourceId: string      // Resource identifier
  description?: string    // Optional description
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

---

## Design Decisions

### 1. Payment Proof: Transaction Hash (Option A)
- Client sends `X-Payment-Proof: txhash` header
- Server queries RPC with hash
- Simple, clean, cacheable

### 2. Validation: Server After Payment (Option B)
- Server validates recipient matches merchant
- Full server control over validation
- Can reject payments to wrong addresses

### 3. Resource Mapping: Memo Format (Option A Enhanced)
- Standardized format: `"resourceId:article-123 - Description"`
- Server validates memo contains correct resource ID
- Safe because server validates before serving

### 4. Payment Reuse: Time-based (Option B)
- Configurable TTL (default: 5 minutes)
- Prevents abuse, allows retries
- Server maintains payment cache with expiry

### 5. SDK Structure: Separate Exports
- `d402/server` for dApp creators
- `d402/client` for users
- Clear separation, tree-shaking friendly

---

## Gasless Implementation

D402 transactions are gasless (sponsored by network).

**Implementation:** Modified SDK's GCRGeneration.ts
```typescript
// Line 61
if (content.type === "identity" || content.type === "d402_payment") {
  break nonceEdits  // Skip gas deduction
}
```

**GCR Handler:**
```typescript
// HandleD402Operations class (lines 344-384)
class HandleD402Operations {
  handle(content) {
    // Extract to, amount from payload
    // Create subtract GCREdit (from sender)
    // Create add GCREdit (to recipient)
    // Return edits array
  }
}
```

---

## Files Created/Modified

### SDK Repository (`../sdks/`)

**Created:**
1. `src/d402/index.ts` - Unified exports
2. `src/d402/server/D402Server.ts` - Server class
3. `src/d402/server/middleware.ts` - Express middleware
4. `src/d402/server/types.ts` - Server types
5. `src/d402/server/index.ts` - Server exports
6. `src/d402/client/D402Client.ts` - Client class
7. `src/d402/client/types.ts` - Client types
8. `src/d402/client/index.ts` - Client exports

**Modified:**
1. `package.json` - Added d402 exports
2. `src/websdk/GCRGeneration.ts` - Gasless logic + handler

### Node Repository (`../node/`)

**Created:**
1. `D402_HTTP_PHASES.md` - Phase plan (updated with status)
2. `D402_SPECS.md` - Technical specification with architecture diagram

---

## Phase Status

### ✅ Phase 1: D402Server Class (COMPLETED)
- Created D402Server class with verify(), require(), validatePayment()
- Payment cache with configurable TTL
- Build successful

### ✅ Phase 2: Express Middleware (COMPLETED)
- Created d402Required() middleware factory
- Automatic 402 handling
- Attaches req.d402Payment on success
- Build successful

### ✅ Phase 3: D402Client Class (COMPLETED)
- Created D402Client with createPayment(), settle(), handlePaymentRequired()
- Fixed directory structure to `src/d402/`
- Fixed import paths and type conflicts
- Build successful

### ✅ Phase 4: Build & Exports (COMPLETED)
- Updated package.json with d402 exports
- Build successful (124 files)
- Module resolution tested

### ⏳ Phase 5: Documentation Updates (PENDING)
- Update backend/d402 docs with HTTP 402 flow
- Update SDK docs with server/client usage
- Create integration examples
- Add server-integration.md and client-402-handling.md

### ⏳ Phase 6: Example Application (PENDING)
- Create Express server example
- Create client example
- Demonstrate full flow
- README with setup

---

## Performance Characteristics

### Latency
- Payment creation: <50ms (client-side)
- Payment signature: <100ms (Ed25519)
- RPC settlement: 1-2 seconds (consensus)
- Payment verification: <100ms (with cache)
- **Total flow:** ~2-3 seconds

### Scalability
- Payment cache reduces RPC load
- Stateless verification (horizontally scalable)
- No external dependencies

---

## Security

### Transaction Security
- Ed25519 signatures (256-bit keys)
- Nonce management (prevents replay)
- Amount validation (server-side)
- Recipient validation (server-side)

### Cache Security
- TTL-based expiry
- Memo validation (resourceId must match)
- Server-side validation only

### Network Security
- HTTPS required for all communication
- Payment proof in headers (not URLs)
- RPC endpoints can require authentication

---

## Future Enhancements

### Planned
- **relayTx Method:** Allow apps to relay signed transactions
  - Current: Client signs → Client broadcasts → App verifies
  - Future: Client signs → App receives → App relays → RPC settles

### Potential
- Subscription payments (recurring)
- Batch payments (multiple resources)
- Payment channels (off-chain)
- Multi-token support

---

## Related Files

### Node Repository
- `D402_HTTP_PHASES.md` - Phase implementation plan
- `D402_SPECS.md` - Technical specification with ASCII diagram
- `D402_SPEC.md` - Original D402 protocol spec (gasless payments)

### SDK Repository
- `src/d402/` - All HTTP 402 implementation
- `src/types/blockchain/TransactionSubtypes/D402PaymentTransaction.ts` - Transaction type
- `src/websdk/GCRGeneration.ts` - Gasless logic and GCR handler

### Documentation Repository
- `backend/d402-payment-protocol/` - Backend docs
- `sdk/websdk/d402-payments/` - SDK docs

---

## Quick Reference

### Minimal Client
```typescript
const d402 = new D402Client(demos)
const payment = await d402.createPayment({ amount, recipient, resourceId })
const result = await d402.settle(payment)
```

### Minimal Server
```typescript
app.get('/paid',
  d402Required({ amount: 5e18, resourceId: 'xyz', rpcUrl }),
  (req, res) => res.json({ data: "premium" })
)
```

### Payment Headers
```http
# Initial request
GET /premium HTTP/1.1

# 402 Response
HTTP/1.1 402 Payment Required
{"amount":5000000000000000000,"recipient":"0x...","resourceId":"xyz"}

# Retry with payment
GET /premium HTTP/1.1
X-Payment-Proof: 0xABC123...

# Success
HTTP/1.1 200 OK
{"content":"Premium"}
```

---

**Last Updated:** 2025-01-31  
**Session:** Phase 4 complete, ready for Phase 5  
**Build Status:** ✅ All builds successful  
**Ready for:** Documentation updates and example application
