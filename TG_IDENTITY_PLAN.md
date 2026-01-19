# Telegram Identity Implementation Plan

## Overview
This document outlines the implementation for adding Telegram identity support to the Demos Network using a transaction-based approach similar to Twitter identities.

**Architecture**: Transaction-based identity system where the Telegram bot submits Demos transactions directly (no API endpoints needed).

## Authentication Flow

### Complete Transaction-Based Flow:
1. **USER** clicks "Link Telegram" on Demos dApp
2. **DAPP** generates challenge and prompts user to sign with wallet
3. **DAPP** shows signed message: "Send this to @DemosBot: `<signed_challenge>`"
4. **USER** sends signed challenge to Telegram bot
5. **BOT** ([separate repository](https://github.com/kynesyslabs/tg_verification_bot)) receives message, verifies user signature
6. **BOT** creates attestation with dual signatures (user + bot)
7. **BOT** submits Demos transaction with telegram identity data
8. **NODE** processes transaction through GCR system → validates → stores identity

## Repository Changes Required

### 🔧 **../sdks Repository Changes**
**Goal**: Create extensible identity transaction subtype supporting multiple platforms

**Files to Create/Edit**:
1. **New transaction subtype**: `web2_identity` or similar
   ```typescript
   // Transaction structure
   {
     type: "identity",
     subtype: "web2_platform", 
     data: {
       platform: "telegram" | "twitter" | "github" | "discord", // extensible
       payload: {
         // Platform-specific data (varies by platform)
         userId: string,
         username: string,
         proof: string, // User signature + bot attestation for telegram
         timestamp: number,
         // ... additional platform-specific fields
       }
     }
   }
   ```

### 🏗️ **Node Repository Changes (This Repo)**
**Goal**: Process telegram identity transactions through existing GCR system

**Files to Edit**:
1. **`/src/libs/blockchain/gcr/gcr_routines/GCRIdentityRoutines.ts`**
   - Add `context: "telegram"` case to `applyWeb2IdentityAdd()`
   - Implement telegram-specific validation (dual signature verification)
   - Bot authorization via genesis block addresses

2. **`/src/libs/blockchain/gcr/gcr_routines/IncentiveManager.ts`**
   - Add `telegramLinked()` and `telegramUnlinked()` methods

3. **`/src/libs/blockchain/gcr/gcr_routines/identityManager.ts`** 
   - Update `filterConnections()` to allow telegram as alternative to twitter

## Implementation Phases

### 📦 **Phase 1: SDK Transaction Types** (../sdks repo)
**Goal**: Create extensible transaction subtype for social identity platforms
**Time**: 1 hour
**Status**: ❌ **NOT STARTED**

**Tasks**:
- Design `web2_platform` transaction subtype
- Support multiple platforms: `telegram`, `twitter`, `github`, `discord`
- Platform-specific payload validation schemas

### 🔧 **Phase 2: Node Transaction Processing** (This repo)  
**Goal**: Process telegram transactions through GCR system
**Time**: 2-3 hours
**Status**: ❌ **NOT STARTED**

**Tasks**:
- Add telegram validation to `GCRIdentityRoutines.applyWeb2IdentityAdd()`
- Implement dual signature verification (user + bot)
- Bot authorization via genesis block
- Telegram incentive integration

### 🤖 **Bot Repository** ([tg_verification_bot](https://github.com/kynesyslabs/tg_verification_bot))
**Status**: ✅ **COMPLETED** - Fully functional verification bot

**Bot Architecture**:
- Complete challenge verification system using DemosSDK
- Dual signature creation (user + bot signatures)
- Rate limiting and security features
- SQLite challenge storage with 15-minute expiration
- Ready to submit Demos transactions (needs transaction type from ../sdks)

**Bot Integration**:
- Bot will use new `web2_platform` transaction subtype from ../sdks
- Bot creates transaction with `{ platform: "telegram", payload: {...} }`
- Bot submits transaction directly to node (no API endpoints needed)

## Security Features

1. **Challenge Expiration**: 15-minute TTL (implemented in bot)
2. **Dual Signature Verification**: User signature + Bot signature required
3. **Bot Authorization**: Only genesis addresses can create valid bot signatures
4. **Transaction-Based Security**: Uses Demos blockchain native validation
5. **Rate Limiting**: Implemented in bot (max attempts per user)
6. **Timestamp Validation**: Recent attestations only (< 15 minutes)

## Success Criteria

### ✅ **Completed (Bot)**:
- [x] Bot handles challenge verification with dual signatures
- [x] Challenge expiration and cleanup (15-minute TTL)
- [x] Rate limiting and security validations
- [x] DemosSDK integration for signature verification

### ❌ **To Do (../sdks repo)**:
- [ ] Create extensible `web2_platform` transaction subtype
- [ ] Support `platform: "telegram"` with validation schemas

### ❌ **To Do (Node repo)**:
- [ ] Process telegram transactions through GCR system
- [ ] Add telegram validation to `GCRIdentityRoutines.applyWeb2IdentityAdd()`
- [ ] Implement bot authorization via genesis block addresses
- [ ] Add telegram incentive integration (`IncentiveManager`)
- [ ] Update identity manager to allow telegram as twitter alternative

## Time Estimate

**Total: 3-4 hours across both repos**
- **../sdks repo**: 1 hour (transaction subtype design)
- **Node repo**: 2-3 hours (GCR integration + validation)

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      TRANSACTION-BASED FLOW                                │
└─────────────────────────────────────────────────────────────────────────────┘

📱 DAPP                    🤖 BOT REPO                    🏗️ NODE REPO
┌─────────────┐           ┌─────────────┐              ┌─────────────┐
│             │           │             │              │             │
│ Generate    │──────────▶│ Receive     │              │             │
│ Challenge   │           │ Signed      │              │             │
│             │           │ Challenge   │              │             │
│ User Signs  │           │             │              │             │
│ with Wallet │           │ Create      │──────────────▶│ Process     │
│             │           │ Attestation │              │ Transaction │
│             │           │             │              │             │
│             │           │ Submit      │              │ Validate:   │
│             │           │ Transaction │              │ • User sig  │
│             │           │             │              │ • Bot sig   │
│             │           │             │              │ • Bot auth  │
│             │           │             │              │             │
│             │           │             │              │ Store       │
│             │           │             │              │ Identity    │
└─────────────┘           └─────────────┘              └─────────────┘

```

**Transaction Flow**: Bot creates transaction → Node validates through GCR → Identity stored
**Security**: Dual signatures (user + bot) + Bot authorization via genesis addresses