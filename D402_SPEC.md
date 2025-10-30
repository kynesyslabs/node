# D402 Protocol Specification

## Demos HTTP Payment Protocol v1.0

**Status**: Draft
**Version**: 1.0.0
**Last Updated**: 2025-10-28

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Message Formats](#message-formats)
4. [Protocol Flow](#protocol-flow)
5. [Facilitator API](#facilitator-api)
6. [Security Model](#security-model)
7. [Error Handling](#error-handling)
8. [Implementation Guidelines](#implementation-guidelines)
9. [Future Extensions](#future-extensions)

---

## 1. Overview

### 1.1 Purpose

D402 (Demos HTTP Payment Protocol) is a payment protocol built on the HTTP 402 Payment Required status code standard, designed specifically for the Demos Network blockchain. It enables seamless integration of native DEM token payments into web services, APIs, and applications.

### 1.2 Design Principles

- **Demos-Native**: Built specifically for Demos Network architecture (DEM, GCR, Omniweb features)
- **Built-In Facilitator**: Integrated into Demos Node for optimal performance
- **HTTP Standard**: Uses W3C standard HTTP 402 status code
- **Fast Settlement**: Target <2 seconds using PoR BFT consensus
- **Developer Friendly**: Simple REST API with clear semantics
- **Secure by Design**: Demos Network supported signatures with nonce-based replay protection (ed25519, PQC...)

### 1.3 Key Features

- Native DEM token payments on Demos Network
- **Gasless Transactions**: D402 payments are sponsored (no gas fees deducted from users)
- Direct GCR integration for balance queries through Demos SDK
- Built-in facilitator service in Demos Node
- RESTful API design

### 1.4 Comparison with X402

While D402 draws inspiration from the x402 protocol concept, it is designed specifically for Demos Network:

| Feature           | X402                             | D402                                           |
| ----------------- | -------------------------------- | ---------------------------------------------- |
| Target Networks   | EVM chains (Base, Polygon, etc.) | Demos Network only                             |
| Token Standard    | ERC-20                           | Native blockchain token (DEM)                  |
| Signature         | EIP-712                          | Demos SDK (ed25519 and others)                 |
| Settlement        | Smart contracts                  | GCR consensus                                  |
| Facilitator       | External service                 | Built into node                                |
| Gas Fees          | Gasless (sponsored)              | Gasless (sponsored)                            |
| Verification Time | Variable (blockchain RPC)        | Near-Instant (through Demos Network consensus) |
| Settlement Time   | 3-30 seconds                     | A couple of seconds                            |

---

## 2. Architecture

### 2.1 System Components

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

### 2.2 Component Responsibilities

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

### 2.3 Network Architecture

- **Primary Network**: Demos Network mainnet
- **Token**: DEM (native blockchain token)
- **Consensus**: PoR (Proof of Representation) BFT
- **State Management**: GCR (Global Change Registry)
- **Balance Storage**: Blockchain Native GCR tables
- **Finality**: Fast finality

---

## 3. Message Formats

### 3.1 TypeScript Type Definitions

```typescript
/**
 * D402 Protocol Version
 */
export const D402_VERSION = "1.0" as const;

/**
 * Payment Scheme Types
 */
export type D402Scheme = "demos-native";

/**
 * Network Identifiers
 */
export type D402Network = "demos-mainnet" | "demos-testnet";

/**
 * Asset Types
 */
export type D402Asset = "DEM";

/**
 * HTTP 402 Payment Requirements Response
 * Returned by services when payment is required
 */
export interface D402PaymentRequired {
  /** Protocol identifier */
  protocol: "d402";

  /** Protocol version */
  version: typeof D402_VERSION;

  /** Accepted payment schemes */
  accepts: D402AcceptedScheme[];
}

/**
 * Accepted Payment Scheme Definition
 */
export interface D402AcceptedScheme {
  /** Payment scheme type */
  scheme: D402Scheme;

  /** Asset to be paid */
  asset: D402Asset;

  /** Target network */
  network: D402Network;

  /** Payee's Demos address (hex format) */
  payTo: string;

  /** Maximum amount required (in smallest unit) */
  maxAmountRequired: string;

  /** Payment timeout in seconds */
  maxTimeoutSeconds: number;

  /** Facilitator endpoint URL */
  facilitator: string;

  /** Optional memo or invoice reference */
  memo?: string;
}

/**
 * Payment Payload
 * Included in service request after receiving 402 response
 */
export interface D402PaymentPayload {
  /** Protocol identifier */
  protocol: "d402";

  /** Payment scheme used */
  scheme: D402Scheme;

  /** Network where payment occurs */
  network: D402Network;

  /** Signed transaction details */
  transaction: D402Transaction;
}

/**
 * Transaction Structure
 * Signed by payer using Ed25519
 */
export interface D402Transaction {
  /** Sender's Demos address (hex format) */
  from: string;

  /** Recipient's Demos address (hex format) */
  to: string;

  /** Amount in smallest unit (e.g., wei equivalent for DEM) */
  amount: number;

  /** Transaction nonce for replay protection */
  nonce: number;

  /** Unix timestamp (seconds) */
  timestamp: number;

  /** Optional memo field */
  memo?: string;

  /** Ed25519 signature */
  signature: D402Signature;
}

/**
 * Ed25519 Signature Structure
 */
export interface D402Signature {
  /** Signature algorithm (always ed25519) */
  algorithm: "ed25519";

  /** Public key (hex format) */
  publicKey: string;

  /** Signature data (hex format) */
  data: string;
}

/**
 * Verification Request
 * Sent by service to facilitator
 */
export interface D402VerificationRequest {
  /** Payment payload from client */
  payment: D402PaymentPayload;

  /** Expected payee address */
  expectedPayee: string;

  /** Minimum required amount */
  minAmount: number;

  /** Maximum allowed timestamp age (seconds) */
  maxAge?: number;
}

/**
 * Verification Response
 * Returned by facilitator
 */
export interface D402VerificationResponse {
  /** Verification success status */
  valid: boolean;

  /** Reason if invalid */
  reason?: string;

  /** Error code if invalid */
  errorCode?: D402ErrorCode;

  /** Transaction hash if valid */
  txHash?: string;

  /** Current balance of sender */
  senderBalance?: number;

  /** Timestamp of verification */
  verifiedAt: number;
}

/**
 * Settlement Request
 * Sent by service to facilitator after successful verification
 */
export interface D402SettlementRequest {
  /** Transaction hash from verification */
  txHash: string;

  /** Payment payload */
  payment: D402PaymentPayload;
}

/**
 * Settlement Response
 * Returned by facilitator after consensus
 */
export interface D402SettlementResponse {
  /** Settlement success status */
  success: boolean;

  /** Transaction hash */
  txHash: string;

  /** Confirmation block number */
  confirmationBlock: number;

  /** Settlement timestamp */
  timestamp: number;

  /** New sender balance after settlement */
  senderBalance: number;

  /** New recipient balance after settlement */
  recipientBalance: number;

  /** Error message if failed */
  error?: string;

  /** Error code if failed */
  errorCode?: D402ErrorCode;
}

/**
 * Error Codes
 */
export enum D402ErrorCode {
  // Verification Errors (1000-1999)
  INVALID_SIGNATURE = 1000,
  INVALID_NONCE = 1001,
  TIMESTAMP_TOO_OLD = 1002,
  TIMESTAMP_TOO_NEW = 1003,
  INSUFFICIENT_BALANCE = 1004,
  INVALID_AMOUNT = 1005,
  INVALID_ADDRESS = 1006,
  REPLAY_ATTACK = 1007,

  // Settlement Errors (2000-2999)
  SETTLEMENT_FAILED = 2000,
  CONSENSUS_TIMEOUT = 2001,
  BALANCE_MISMATCH = 2002,
  ALREADY_SETTLED = 2003,

  // Network Errors (3000-3999)
  NETWORK_ERROR = 3000,
  GCR_UNAVAILABLE = 3001,
  NODE_UNREACHABLE = 3002,

  // Protocol Errors (4000-4999)
  INVALID_PROTOCOL = 4000,
  UNSUPPORTED_VERSION = 4001,
  MALFORMED_REQUEST = 4002,
  MISSING_REQUIRED_FIELD = 4003,
}

/**
 * Error Response
 */
export interface D402Error {
  /** Error code */
  code: D402ErrorCode;

  /** Human-readable error message */
  message: string;

  /** Additional error details */
  details?: Record<string, any>;

  /** Timestamp */
  timestamp: number;
}
```

### 3.2 Message Signing

#### 3.2.1 Transaction Signing Process

1. **Create Transaction Object** (without signature):
   
   ```typescript
   const transaction = {
   from: "abc123...def",
   to: "xyz789...ghi",
   amount: 1000000,
   nonce: 42,
   timestamp: Math.floor(Date.now() / 1000),
   memo: "Payment for API access"
   };
   ```

2. **Serialize for Signing**:
   
   ```typescript
   // Canonical JSON serialization (sorted keys)
   const message = JSON.stringify(transaction, Object.keys(transaction).sort());
   ```

3. **Sign with Ed25519**:
   
   ```typescript
   // Using Demos SDK cryptography library
   import { Cryptography } from '@kynesyslabs/demosdk';
   ```

const signature = Cryptography.sign(message, privateKeyBuffer);
const signatureHex = forge.util.binary.hex.encode(signature);

```
4. **Complete Transaction**:
```typescript
const signedTransaction: D402Transaction = {
  ...transaction,
  signature: {
    algorithm: "ed25519",
    publicKey: publicKeyHex,
    data: signatureHex
  }
};
```

#### 3.2.2 Signature Verification Process

1. **Extract Transaction Fields** (excluding signature):
   
   ```typescript
   const { signature, ...transactionData } = receivedTransaction;
   ```

2. **Recreate Message**:
   
   ```typescript
   const message = JSON.stringify(transactionData, Object.keys(transactionData).sort());
   ```

3. **Verify Signature**:
   
   ```typescript
   const isValid = forge.pki.ed25519.verify({
   message,
   encoding: 'utf8',
   signature: forge.util.binary.hex.decode(signature.data),
   publicKey: forge.util.binary.hex.decode(signature.publicKey)
   });
   ```

4. **Verify Address Match**:
   
   ```typescript
   // Ensure public key in signature matches 'from' address
   const derivedAddress = Cryptography.getAddressFromPublicKey(signature.publicKey);
   if (derivedAddress !== transactionData.from) {
   throw new Error("Address mismatch");
   }
   ```

---

## 4. Protocol Flow

### 4.1 Complete Payment Flow

```
┌──────────┐                          ┌──────────┐                          ┌──────────┐
│  Client  │                          │ Service  │                          │   Node   │
│ (Buyer)  │                          │ (Seller) │                          │(Facilit) │
└──────────┘                          └──────────┘                          └──────────┘
     │                                     │                                     │
     │  GET /api/resource                  │                                     │
     │────────────────────────────────────>│                                     │
     │                                     │                                     │
     │  HTTP 402 Payment Required          │                                     │
     │  + D402PaymentRequired              │                                     │
     │<────────────────────────────────────│                                     │
     │  {                                  │                                     │
     │    protocol: "d402",                │                                     │
     │    accepts: [{                      │                                     │
     │      scheme: "demos-native",        │                                     │
     │      asset: "DEM",                  │                                     │
     │      payTo: "seller_address",       │                                     │
     │      maxAmountRequired: "1000000",  │                                     │
     │      facilitator: "https://..."     │                                     │
     │    }]                               │                                     │
     │  }                                  │                                     │
     │                                     │                                     │
     ├─ Create Payment ─────────────────┐  │                                     │
     │  - Get nonce                     │  │                                     │
     │  - Sign transaction              │  │                                     │
     │  - Create D402PaymentPayload     │  │                                     │
     └──────────────────────────────────┘  │                                     │
     │                                     │                                     │
     │  GET /api/resource                  │                                     │
     │  Header: D402-Payment: <payload>    │                                     │
     │────────────────────────────────────>│                                     │
     │                                     │                                     │
     │                                     │  POST /d402/verify                  │
     │                                     │  Body: D402VerificationRequest      │
     │                                     │────────────────────────────────────>│
     │                                     │                                     │
     │                                     │                                     ├─ Verify ─┐
     │                                     │                                     │  - Check  │
     │                                     │                                     │    sig    │
     │                                     │                                     │  - Check  │
     │                                     │                                     │    balance│
     │                                     │                                     │  - Check  │
     │                                     │                                     │    nonce  │
     │                                     │                                     └───────────┘
     │                                     │                                     │
     │                                     │  D402VerificationResponse           │
     │                                     │  { valid: true, txHash: "..." }     │
     │                                     │<────────────────────────────────────│
     │                                     │                                     │
     │                                     │  POST /d402/settle                  │
     │                                     │  Body: D402SettlementRequest        │
     │                                     │────────────────────────────────────>│
     │                                     │                                     │
     │                                     │                                     ├─ Settle ──┐
     │                                     │                                     │  - Submit │
     │                                     │                                     │    to GCR │
     │                                     │                                     │  - PoR BFT│
     │                                     │                                     │  - Update │
     │                                     │                                     │    balance│
     │                                     │                                     └───────────┘
     │                                     │                                     │
     │                                     │  D402SettlementResponse             │
     │                                     │  { success: true, txHash: "...",    │
     │                                     │    confirmationBlock: 12345 }       │
     │                                     │<────────────────────────────────────│
     │                                     │                                     │
     │  HTTP 200 OK                        │                                     │
     │  + Resource Content                 │                                     │
     │<────────────────────────────────────│                                     │
     │                                     │                                     │
```

### 4.2 State Transitions

**Transaction States**:

1. **CREATED**: Transaction created and signed by client
2. **VERIFIED**: Signature and balance verified by facilitator
3. **SETTLING**: Submitted to GCR for consensus
4. **SETTLED**: Confirmed on blockchain, balances updated
5. **FAILED**: Verification or settlement failed

**State Transition Rules**:

- CREATED → VERIFIED: Valid signature, sufficient balance, valid nonce
- VERIFIED → SETTLING: Service requests settlement
- SETTLING → SETTLED: PoR BFT consensus reached
- Any → FAILED: Validation error or consensus failure

### 4.3 Nonce Management

**Purpose**: Prevent replay attacks and ensure transaction uniqueness

**Implementation**:

```typescript
// Client-side nonce generation
function generateNonce(address: string): number {
  // Get last used nonce from local storage or API
  const lastNonce = getLastNonce(address);

  // Increment by 1
  return lastNonce + 1;
}

// Facilitator-side nonce validation
function validateNonce(address: string, nonce: number): boolean {
  // Get last settled nonce from GCR
  const lastSettledNonce = getLastSettledNonce(address);

  // Nonce must be exactly lastSettledNonce + 1
  return nonce === lastSettledNonce + 1;
}
```

**Nonce Storage**:

- Stored in GCR per address
- Updated atomically during settlement
- Queryable via facilitator API

---

## 5. Facilitator API

### 5.1 Endpoints

#### 5.1.1 Health Check

```
GET /d402/health
```

**Response**:

```typescript
{
  "status": "healthy",
  "version": "1.0",
  "network": "demos-mainnet",
  "blockHeight": 12345,
  "timestamp": 1234567890
}
```

#### 5.1.2 Get Address Nonce

```
GET /d402/nonce/:address
```

**Response**:

```typescript
{
  "address": "abc123...def",
  "nonce": 42,
  "timestamp": 1234567890
}
```

#### 5.1.3 Verify Payment

```
POST /d402/verify
Content-Type: application/json
```

**Request Body**: `D402VerificationRequest`

```json
{
  "payment": {
    "protocol": "d402",
    "scheme": "demos-native",
    "network": "demos-mainnet",
    "transaction": {
      "from": "sender_address_hex",
      "to": "recipient_address_hex",
      "amount": 1000000,
      "nonce": 42,
      "timestamp": 1234567890,
      "signature": {
        "algorithm": "ed25519",
        "publicKey": "pubkey_hex",
        "data": "signature_hex"
      }
    }
  },
  "expectedPayee": "recipient_address_hex",
  "minAmount": 1000000
}
```

**Response**: `D402VerificationResponse`

```json
{
  "valid": true,
  "txHash": "hash_of_transaction",
  "senderBalance": 5000000,
  "verifiedAt": 1234567890
}
```

**Error Response**:

```json
{
  "valid": false,
  "reason": "Insufficient balance",
  "errorCode": 1004,
  "verifiedAt": 1234567890
}
```

#### 5.1.4 Settle Payment

```
POST /d402/settle
Content-Type: application/json
```

**Request Body**: `D402SettlementRequest`

```json
{
  "txHash": "hash_from_verification",
  "payment": {
    "protocol": "d402",
    "scheme": "demos-native",
    "network": "demos-mainnet",
    "transaction": { /* ... */ }
  }
}
```

**Response**: `D402SettlementResponse`

```json
{
  "success": true,
  "txHash": "final_transaction_hash",
  "confirmationBlock": 12346,
  "timestamp": 1234567891,
  "senderBalance": 4000000,
  "recipientBalance": 1001000
}
```

**Error Response**:

```json
{
  "success": false,
  "txHash": "hash",
  "error": "Settlement failed: consensus timeout",
  "errorCode": 2001,
  "timestamp": 1234567891
}
```

### 5.2 HTTP Headers

**Client Request Headers**:

```
D402-Payment: <base64-encoded-D402PaymentPayload>
D402-Version: 1.0
Content-Type: application/json
```

**Service Response Headers (402)**:

```
HTTP/1.1 402 Payment Required
Content-Type: application/json
D402-Version: 1.0
```

---

## 6. Security Model

### 6.1 Cryptographic Security

**Signature Algorithm**: Ed25519

- **Key Size**: 256-bit
- **Signature Size**: 512-bit
- **Security Level**: ~128-bit (quantum-resistant considerations for future)
- **Library**: node-forge (`forge.pki.ed25519`)

**Key Management**:

- Private keys NEVER leave client
- Public keys included in signatures for verification
- Address derived from public key for authentication

### 6.2 Replay Attack Prevention

**Mechanisms**:

1. **Nonce System**:
   
   - Sequential nonces per address
   - Stored in GCR, updated atomically
   - Nonce must be exactly `lastNonce + 1`

2. **Timestamp Validation**:
   
   - Transactions must be within acceptable time window
   - Default: ±5 minutes from current time
   - Configurable per service

3. **Transaction Hash Tracking**:
   
   - All settled transactions stored in GCR
   - Duplicate txHash detection

**Example Attack Prevention**:

```typescript
// Attacker captures payment payload
const capturedPayload = interceptedRequest.payment;

// Attempts replay
const replayAttempt = sendPayment(capturedPayload);

// Facilitator rejects: nonce already used
// Result: 1007 REPLAY_ATTACK error
```

### 6.3 Amount Validation

**Checks**:

1. **Non-negative**: Amount > 0
2. **Sufficient Balance**: Sender balance ≥ amount
3. **Expected Amount**: Amount ≥ service's minAmount
4. **Maximum Limit**: Amount ≤ service's maxAmount (if specified)

### 6.4 Address Validation

**Verification Steps**:

1. **Format Check**: Valid hex-encoded Demos address
2. **Public Key Match**: Derive address from signature public key
3. **Address Match**: Derived address === transaction.from
4. **Payee Match**: transaction.to === expectedPayee (service check)

### 6.5 Facilitator Trust Model

**Trust Assumptions**:

- Facilitator (Demos Node) is trusted for:
  - Accurate balance queries
  - Honest settlement execution
  - Proper nonce management
  - Secure key storage

**Trust Minimization**:

- Multiple facilitator support (future)
- Verifiable settlement receipts
- Public blockchain state
- Open-source implementation

### 6.6 Network Security

**TLS Requirements**:

- All facilitator endpoints MUST use HTTPS
- TLS 1.2 minimum, TLS 1.3 recommended
- Valid SSL certificates required

**DDoS Protection**:

- Rate limiting on facilitator endpoints
- Verification caching for duplicate requests
- Nonce-based request deduplication

---

## 7. Error Handling

### 7.1 Error Categories

#### 7.1.1 Verification Errors (1000-1999)

| Code | Name                 | Description                            | Recovery                                      |
| ---- | -------------------- | -------------------------------------- | --------------------------------------------- |
| 1000 | INVALID_SIGNATURE    | Ed25519 signature verification failed  | Check signing process, verify private key     |
| 1001 | INVALID_NONCE        | Nonce doesn't match expected sequence  | Fetch current nonce and retry                 |
| 1002 | TIMESTAMP_TOO_OLD    | Transaction timestamp is too old       | Create new transaction with current timestamp |
| 1003 | TIMESTAMP_TOO_NEW    | Transaction timestamp is in the future | Synchronize system clock                      |
| 1004 | INSUFFICIENT_BALANCE | Sender balance < required amount       | Add funds to sender address                   |
| 1005 | INVALID_AMOUNT       | Amount is zero or negative             | Fix amount value                              |
| 1006 | INVALID_ADDRESS      | Malformed or non-existent address      | Verify address format                         |
| 1007 | REPLAY_ATTACK        | Transaction already settled            | Not recoverable (security block)              |

#### 7.1.2 Settlement Errors (2000-2999)

| Code | Name              | Description                       | Recovery                |
| ---- | ----------------- | --------------------------------- | ----------------------- |
| 2000 | SETTLEMENT_FAILED | GCR operation failed              | Retry settlement        |
| 2001 | CONSENSUS_TIMEOUT | PoR BFT consensus timeout         | Wait and retry          |
| 2002 | BALANCE_MISMATCH  | Balance changed during settlement | Re-verify and retry     |
| 2003 | ALREADY_SETTLED   | Transaction already on-chain      | Query settlement status |

#### 7.1.3 Network Errors (3000-3999)

| Code | Name             | Description              | Recovery                    |
| ---- | ---------------- | ------------------------ | --------------------------- |
| 3000 | NETWORK_ERROR    | Generic network failure  | Retry with backoff          |
| 3001 | GCR_UNAVAILABLE  | GCR database unreachable | Wait for node recovery      |
| 3002 | NODE_UNREACHABLE | Facilitator node offline | Use alternative facilitator |

#### 7.1.4 Protocol Errors (4000-4999)

| Code | Name                   | Description                     | Recovery                 |
| ---- | ---------------------- | ------------------------------- | ------------------------ |
| 4000 | INVALID_PROTOCOL       | Protocol field != "d402"        | Fix protocol field       |
| 4001 | UNSUPPORTED_VERSION    | Version not supported           | Check supported versions |
| 4002 | MALFORMED_REQUEST      | JSON parsing or structure error | Fix request format       |
| 4003 | MISSING_REQUIRED_FIELD | Required field missing          | Add missing field        |

### 7.2 Error Response Format

All errors follow this structure:

```typescript
{
  "error": {
    "code": 1004,
    "message": "Insufficient balance",
    "details": {
      "required": 1000000,
      "available": 500000,
      "address": "abc123...def"
    },
    "timestamp": 1234567890
  }
}
```

### 7.3 Retry Logic

**Recommended Retry Strategy**:

```typescript
const RETRY_CONFIG = {
  // Retryable errors
  retryable: [
    D402ErrorCode.NETWORK_ERROR,
    D402ErrorCode.GCR_UNAVAILABLE,
    D402ErrorCode.NODE_UNREACHABLE,
    D402ErrorCode.CONSENSUS_TIMEOUT,
    D402ErrorCode.BALANCE_MISMATCH
  ],

  // Non-retryable errors (fatal)
  fatal: [
    D402ErrorCode.INVALID_SIGNATURE,
    D402ErrorCode.REPLAY_ATTACK,
    D402ErrorCode.INVALID_ADDRESS
  ],

  // Retry with nonce refresh
  nonceRefresh: [
    D402ErrorCode.INVALID_NONCE
  ],

  // Max retry attempts
  maxRetries: 3,

  // Exponential backoff
  backoffMs: [1000, 2000, 4000]
};
```

**Example Retry Implementation**:

```typescript
async function payWithRetry(
  payment: D402PaymentPayload,
  retries = 3
): Promise<D402SettlementResponse> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const verification = await verifyPayment(payment);

      if (!verification.valid) {
        // Handle verification errors
        if (RETRY_CONFIG.fatal.includes(verification.errorCode)) {
          throw new Error(`Fatal error: ${verification.reason}`);
        }

        if (RETRY_CONFIG.nonceRefresh.includes(verification.errorCode)) {
          // Refresh nonce and recreate payment
          payment = await recreatePaymentWithNewNonce(payment);
          continue;
        }
      }

      // Attempt settlement
      const settlement = await settlePayment(verification.txHash, payment);

      if (settlement.success) {
        return settlement;
      }

      // Check if retryable
      if (!RETRY_CONFIG.retryable.includes(settlement.errorCode)) {
        throw new Error(`Settlement failed: ${settlement.error}`);
      }

    } catch (error) {
      if (attempt === retries - 1) throw error;

      // Exponential backoff
      await sleep(RETRY_CONFIG.backoffMs[attempt]);
    }
  }

  throw new Error("Max retries exceeded");
}
```

### 7.4 Client-Side Error Handling

**Best Practices**:

1. **Validation Before Sending**:
   
   ```typescript
   function validatePaymentBeforeSend(tx: D402Transaction): void {
     if (tx.amount <= 0) throw new Error("Amount must be positive");
     if (!isValidAddress(tx.from)) throw new Error("Invalid sender address");
     if (!isValidAddress(tx.to)) throw new Error("Invalid recipient address");
     if (tx.timestamp < Date.now()/1000 - 300) throw new Error("Timestamp too old");
   }
   ```

2. **User-Friendly Error Messages**:
   
   ```typescript
   function getUserErrorMessage(errorCode: D402ErrorCode): string {
     switch (errorCode) {
       case D402ErrorCode.INSUFFICIENT_BALANCE:
         return "You don't have enough DEM tokens. Please add funds to your wallet.";
       case D402ErrorCode.INVALID_NONCE:
         return "Transaction out of order. Retrying with updated information...";
       case D402ErrorCode.CONSENSUS_TIMEOUT:
         return "Network is busy. Please wait a moment and try again.";
       default:
         return "Payment failed. Please try again.";
     }
   }
   ```

3. **Logging and Monitoring**:
   
   ```typescript
   function logPaymentError(error: D402Error, context: any): void {
     console.error("D402 Payment Error", {
       code: error.code,
       message: error.message,
       details: error.details,
       context: context,
       timestamp: new Date().toISOString()
     });
   
     // Send to monitoring service
     sendToMonitoring({
       type: "d402_error",
       severity: getSeverity(error.code),
       error: error
     });
   }
   ```

---

## 8. Implementation Guidelines

### 8.1 Service Integration (Seller)

**Step 1: Check for Payment Header**

```typescript
import { D402PaymentPayload } from './d402-types';

app.get('/api/protected-resource', async (req, res) => {
  const paymentHeader = req.headers['d402-payment'];

  if (!paymentHeader) {
    // Return 402 Payment Required
    return res.status(402).json({
      protocol: "d402",
      version: "1.0",
      accepts: [{
        scheme: "demos-native",
        asset: "DEM",
        network: "demos-mainnet",
        payTo: process.env.DEMOS_ADDRESS,
        maxAmountRequired: "1000000", // 1 DEM
        maxTimeoutSeconds: 60,
        facilitator: "https://node.demos.network/d402",
        memo: "API access fee"
      }]
    });
  }

  // Payment present, proceed to verification
  const payment: D402PaymentPayload = JSON.parse(
    Buffer.from(paymentHeader, 'base64').toString()
  );

  // Verify payment...
});
```

**Step 2: Verify Payment**

```typescript
async function verifyPayment(
  payment: D402PaymentPayload,
  expectedPayee: string,
  minAmount: number
): Promise<D402VerificationResponse> {
  const facilitatorUrl = "https://node.demos.network/d402/verify";

  const response = await fetch(facilitatorUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      payment,
      expectedPayee,
      minAmount
    })
  });

  return await response.json();
}
```

**Step 3: Settle Payment**

```typescript
async function settlePayment(
  txHash: string,
  payment: D402PaymentPayload
): Promise<D402SettlementResponse> {
  const facilitatorUrl = "https://node.demos.network/d402/settle";

  const response = await fetch(facilitatorUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      txHash,
      payment
    })
  });

  return await response.json();
}
```

**Step 4: Complete Transaction**

```typescript
app.get('/api/protected-resource', async (req, res) => {
  // ... payment parsing ...

  // Verify
  const verification = await verifyPayment(
    payment,
    process.env.DEMOS_ADDRESS,
    1000000
  );

  if (!verification.valid) {
    return res.status(402).json({
      error: verification.reason,
      code: verification.errorCode
    });
  }

  // Settle
  const settlement = await settlePayment(verification.txHash, payment);

  if (!settlement.success) {
    return res.status(500).json({
      error: settlement.error,
      code: settlement.errorCode
    });
  }

  // Deliver content
  res.json({
    success: true,
    data: { /* protected resource */ },
    payment: {
      txHash: settlement.txHash,
      block: settlement.confirmationBlock
    }
  });
});
```

### 8.2 Client Integration (Buyer)

**Step 1: Detect 402 Response**

```typescript
import { D402Client } from '@kynesyslabs/demosdk/d402';

const client = new D402Client({
  privateKey: userPrivateKey,
  network: 'demos-mainnet'
});

async function fetchProtectedResource(url: string) {
  // Initial request
  const response = await fetch(url);

  if (response.status === 402) {
    // Payment required
    const paymentRequired = await response.json();
    return await handlePaymentRequired(url, paymentRequired);
  }

  return response;
}
```

**Step 2: Create Payment**

```typescript
async function handlePaymentRequired(
  url: string,
  paymentRequired: D402PaymentRequired
) {
  // Get payment scheme
  const scheme = paymentRequired.accepts[0];

  // Get current nonce
  const nonce = await client.getNonce();

  // Create signed payment
  const payment = await client.createPayment({
    to: scheme.payTo,
    amount: parseInt(scheme.maxAmountRequired),
    nonce,
    memo: scheme.memo
  });

  // Retry request with payment
  return await fetch(url, {
    headers: {
      'D402-Payment': Buffer.from(JSON.stringify(payment)).toString('base64'),
      'D402-Version': '1.0'
    }
  });
}
```

**Step 3: Handle Response**

```typescript
const response = await fetchProtectedResource('/api/protected-resource');

if (response.ok) {
  const data = await response.json();
  console.log("Resource accessed:", data);
  console.log("Payment confirmed:", data.payment.txHash);
} else {
  console.error("Payment failed:", await response.json());
}
```

### 8.3 Facilitator Implementation (Demos Node)

**Integration Points in Demos Node**:

```typescript
// src/libs/network/rpc/d402/facilitator.ts

import { GCR } from '@/libs/blockchain/gcr/gcr';
import { Cryptography } from '@/libs/crypto/cryptography';
import { SubOperations } from '@/libs/blockchain/routines/subOperations';

export class D402Facilitator {
  /**
   * Verify payment transaction
   */
  async verify(request: D402VerificationRequest): Promise<D402VerificationResponse> {
    const { payment, expectedPayee, minAmount } = request;
    const tx = payment.transaction;

    // 1. Verify signature
    const isValidSignature = await this.verifySignature(tx);
    if (!isValidSignature) {
      return {
        valid: false,
        reason: "Invalid signature",
        errorCode: D402ErrorCode.INVALID_SIGNATURE,
        verifiedAt: Date.now()
      };
    }

    // 2. Check balance
    const balance = await GCR.getGCRNativeBalance(tx.from);
    if (balance < tx.amount) {
      return {
        valid: false,
        reason: "Insufficient balance",
        errorCode: D402ErrorCode.INSUFFICIENT_BALANCE,
        senderBalance: balance,
        verifiedAt: Date.now()
      };
    }

    // 3. Verify nonce
    const lastNonce = await this.getLastNonce(tx.from);
    if (tx.nonce !== lastNonce + 1) {
      return {
        valid: false,
        reason: "Invalid nonce",
        errorCode: D402ErrorCode.INVALID_NONCE,
        verifiedAt: Date.now()
      };
    }

    // 4. Check timestamp
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(tx.timestamp - now) > 300) { // 5 minutes
      return {
        valid: false,
        reason: "Timestamp out of range",
        errorCode: D402ErrorCode.TIMESTAMP_TOO_OLD,
        verifiedAt: Date.now()
      };
    }

    // 5. Verify recipient
    if (tx.to !== expectedPayee) {
      return {
        valid: false,
        reason: "Recipient mismatch",
        errorCode: D402ErrorCode.INVALID_ADDRESS,
        verifiedAt: Date.now()
      };
    }

    // 6. Verify amount
    if (tx.amount < minAmount) {
      return {
        valid: false,
        reason: "Amount too low",
        errorCode: D402ErrorCode.INVALID_AMOUNT,
        verifiedAt: Date.now()
      };
    }

    // All checks passed
    const txHash = this.calculateTxHash(tx);
    return {
      valid: true,
      txHash,
      senderBalance: balance,
      verifiedAt: Date.now()
    };
  }

  /**
   * Settle verified payment
   */
  async settle(request: D402SettlementRequest): Promise<D402SettlementResponse> {
    const { txHash, payment } = request;
    const tx = payment.transaction;

    try {
      // Create operation for GCR
      const operation: Operation = {
        hash: txHash,
        type: "transfer",
        params: {
          from: tx.from,
          to: tx.to,
          amount: tx.amount.toString()
        }
      };

      // Execute transfer via SubOperations
      const result = await SubOperations.transferNative(operation);

      if (!result.success) {
        return {
          success: false,
          txHash,
          error: result.message,
          errorCode: D402ErrorCode.SETTLEMENT_FAILED,
          timestamp: Date.now()
        };
      }

      // Get updated balances
      const senderBalance = await GCR.getGCRNativeBalance(tx.from);
      const recipientBalance = await GCR.getGCRNativeBalance(tx.to);

      // Update nonce
      await this.updateNonce(tx.from, tx.nonce);

      // Get confirmation block (latest block number)
      const confirmationBlock = await this.getCurrentBlockHeight();

      return {
        success: true,
        txHash,
        confirmationBlock,
        timestamp: Date.now(),
        senderBalance,
        recipientBalance
      };

    } catch (error) {
      return {
        success: false,
        txHash,
        error: error.message,
        errorCode: D402ErrorCode.SETTLEMENT_FAILED,
        timestamp: Date.now()
      };
    }
  }

  /**
   * Verify Ed25519 signature
   */
  private async verifySignature(tx: D402Transaction): Promise<boolean> {
    const { signature, ...txData } = tx;

    // Canonical JSON
    const message = JSON.stringify(txData, Object.keys(txData).sort());

    // Verify signature
    const isValid = forge.pki.ed25519.verify({
      message,
      encoding: 'utf8',
      signature: forge.util.binary.hex.decode(signature.data),
      publicKey: forge.util.binary.hex.decode(signature.publicKey)
    });

    if (!isValid) return false;

    // Verify address matches public key
    const derivedAddress = Cryptography.getAddressFromPublicKey(signature.publicKey);
    return derivedAddress === txData.from;
  }
}
```

### 8.4 Performance Optimization

**Caching Strategy**:

```typescript
// src/libs/network/rpc/d402/cache.ts

interface VerificationCache {
  [txHash: string]: {
    result: D402VerificationResponse;
    timestamp: number;
  };
}

const verificationCache: VerificationCache = {};
const CACHE_TTL = 60000; // 1 minute

export function getCachedVerification(txHash: string): D402VerificationResponse | null {
  const cached = verificationCache[txHash];
  if (!cached) return null;

  // Check TTL
  if (Date.now() - cached.timestamp > CACHE_TTL) {
    delete verificationCache[txHash];
    return null;
  }

  return cached.result;
}

export function cacheVerification(txHash: string, result: D402VerificationResponse): void {
  verificationCache[txHash] = {
    result,
    timestamp: Date.now()
  };
}
```

**Connection Pooling**:

```typescript
// Reuse database connections
const pool = await Datasource.getInstance().getDataSource().createQueryRunner();

// Batch nonce queries
async function getNonceBatch(addresses: string[]): Promise<Map<string, number>> {
  const nonces = await pool.query(`
    SELECT public_key, last_nonce
    FROM demos_nonces
    WHERE public_key = ANY($1)
  `, [addresses]);

  return new Map(nonces.map(row => [row.public_key, row.last_nonce]));
}
```

---

## 9. Future Extensions

### 9.1 Multi-Token Support

**Planned Extension**: Support custom fungible tokens on Demos Network

```typescript
interface D402TokenScheme extends D402AcceptedScheme {
  scheme: "demos-token";
  tokenAddress: string; // Custom token address on Demos
  tokenSymbol: string; // e.g., "DUSDC", "DWETH"
  decimals: number;
}
```

### 9.2 Subscription Payments

**Planned Extension**: Recurring payment support

```typescript
interface D402SubscriptionScheme extends D402AcceptedScheme {
  scheme: "demos-subscription";
  interval: "daily" | "weekly" | "monthly";
  totalPayments: number;
  allowCancel: boolean;
}
```

### 9.3 Multi-Facilitator Support

**Planned Extension**: Decentralized facilitator network

```typescript
interface D402AcceptedScheme {
  // ... existing fields ...
  facilitators: string[]; // Multiple facilitator URLs
  facilitatorThreshold: number; // Required confirmations
}
```

### 9.4 Cross-Chain Compatibility

**Future Consideration**: X402 interoperability layer

```typescript
// Potential bridge between D402 and x402 networks
interface D402BridgeScheme {
  scheme: "demos-bridge";
  targetNetwork: "base" | "polygon" | "solana";
  bridgeContract: string;
  wrappedAsset: string; // e.g., wDEM on Base
}
```

### 9.5 Payment Channels

**Future Consideration**: State channels for high-frequency micropayments

```typescript
interface D402ChannelScheme {
  scheme: "demos-channel";
  channelId: string;
  deposit: number;
  expiresAt: number;
}
```

---

## 10. Appendices

### 10.1 Glossary

- **DEM**: Native token of Demos Network
- **GCR**: Global Change Registry - Demos Network's state management system
- **PoR BFT**: Proof of Reputation Byzantine Fault Tolerant consensus
- **Ed25519**: Elliptic curve signature scheme used by Demos Network
- **Facilitator**: Payment verification and settlement service
- **Nonce**: Number used once - sequential counter for replay protection
- **Settlement**: Final blockchain confirmation of payment transfer

### 10.2 References

- **HTTP 402 Status Code**: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/402
- **Ed25519 Specification**: https://datatracker.ietf.org/doc/html/rfc8032
- **X402 Protocol**: https://docs.x402.org (inspiration source)
- **Demos Network Documentation**: https://docs.kynesys.xyz
- **Demos SDK**: https://www.npmjs.com/package/@kynesyslabs/demosdk

### 10.3 Version History

- **v1.0.0** (2025-10-28): Initial specification
  - Core protocol design
  - Payment verification and settlement
  - Ed25519 signature support
  - Nonce-based replay protection
  - HTTP 402 integration

---

**End of D402 Protocol Specification v1.0**
