# Project Patterns: Telegram Identity Verification System

## Architecture Overview

The Demos Network implements a dual-signature telegram identity verification system with the following key components:

### **Core Components**
- **Telegram Bot**: Creates signed attestations for user telegram identities
- **Node RPC**: Verifies bot signatures and user ownership
- **Genesis Block**: Contains authorized bot addresses with balances
- **Point System**: Awards/deducts points for telegram account linking/unlinking

## Key Architectural Patterns

### **Demos Address = Public Key Pattern**
```typescript
// Fundamental Demos Network pattern - addresses ARE Ed25519 public keys
const botSignatureValid = await ucrypto.verify({
    algorithm: signature.type,
    message: new TextEncoder().encode(messageToVerify),
    publicKey: hexToUint8Array(botAddress), // ✅ CORRECT: Address = Public Key
    signature: hexToUint8Array(signature.data),
})
```

**Key Insight**: Unlike Ethereum (address = hash of public key), Demos uses raw Ed25519 public keys as addresses

### **Bot Authorization Pattern**
```typescript
// Bots are authorized by having non-zero balance in genesis block
async function checkBotAuthorization(botAddress: string): Promise<boolean> {
    const genesisBlock = await chainModule.getGenesisBlock()
    const balances = genesisBlock.content.balances
    // Check if botAddress exists with non-zero balance
    return foundInGenesisWithBalance(botAddress, balances)
}
```

### **Telegram Attestation Flow**
1. **User requests identity verification** via telegram bot
2. **Bot creates TelegramAttestationPayload** with user data
3. **Bot signs attestation** with its private key
4. **User submits TelegramSignedAttestation** to node
5. **Node verifies**:
   - Bot signature against attestation payload
   - Bot authorization via genesis block lookup
   - User ownership via public key matching

## Data Structure Patterns

### **Point System Defensive Initialization**
```typescript
// PATTERN: Property-level null coalescing for partial objects
socialAccounts: {
    twitter: account.points.breakdown?.socialAccounts?.twitter ?? 0,
    github: account.points.breakdown?.socialAccounts?.github ?? 0, 
    telegram: account.points.breakdown?.socialAccounts?.telegram ?? 0,
    discord: account.points.breakdown?.socialAccounts?.discord ?? 0,
}

// ANTI-PATTERN: Object-level fallback missing individual properties
socialAccounts: account.points.breakdown?.socialAccounts || defaultObject
```

### **Structure Initialization Guards**
```typescript
// PATTERN: Ensure complete structure before assignment
account.points.breakdown = account.points.breakdown || {
    web3Wallets: {},
    socialAccounts: { twitter: 0, github: 0, telegram: 0, discord: 0 },
    referrals: 0,
    demosFollow: 0,
}
```

## Common Pitfalls and Solutions

### **Null Pointer Logic Errors**
```typescript
// PROBLEM: undefined <= 0 returns false (should return true)
if (userPoints.breakdown.socialAccounts.telegram <= 0) // ❌ Bug

// SOLUTION: Extract with null coalescing first
const currentTelegram = userPoints.breakdown.socialAccounts?.telegram ?? 0
if (currentTelegram <= 0) // ✅ Safe
```

### **Import Path Security**
```typescript
// PROBLEM: Brittle internal path dependencies
import { Type } from "node_modules/@kynesyslabs/demosdk/build/types/abstraction" // ❌

// SOLUTION: Use proper package exports
import { Type } from "@kynesyslabs/demosdk/abstraction" // ✅
```

## Performance Optimization Opportunities

### **Genesis Block Caching**
- Current: Genesis block queried on every bot authorization check
- Opportunity: Cache authorized bot set after first load
- Impact: Reduced RPC calls and faster telegram verifications

### **Structure Initialization**
- Current: Structure initialized on every point operation  
- Opportunity: Initialize once at account creation
- Impact: Reduced processing overhead in high-frequency operations

## Testing Patterns

### **Signature Verification Testing**
- Test with actual Ed25519 key pairs
- Verify bot authorization via genesis block simulation
- Test null/undefined edge cases in point system
- Validate telegram identity payload structure

### **Data Integrity Testing**
- Test partial socialAccounts objects
- Verify negative point prevention
- Test structure initialization guards
- Validate cross-platform consistency

## Security Considerations

### **Bot Authorization Security**
- Only genesis-funded addresses can act as bots
- Prevents unauthorized attestation creation
- Immutable authorization via blockchain state

### **Signature Verification Security**
- Dual verification: user ownership + bot attestation
- Consistent cryptographic patterns across transaction types
- Protection against replay attacks via timestamp inclusion

This pattern knowledge enables reliable telegram identity verification with proper security, performance, and data integrity guarantees.