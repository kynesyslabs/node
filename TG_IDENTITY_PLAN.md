# Telegram Identity Implementation Plan - Node Side Only

## Overview
This document outlines the node-side implementation for adding Telegram identity support to the Demos Network, following the dApp → Challenge → Bot → Verification flow pattern.

**Note**: The Telegram bot implementation is in a separate repository. This plan focuses only on the node-side changes needed to support the verification flow.

## Authentication Flow

### Complete Flow:
1. **USER** clicks "Link Telegram" on Demos dApp
2. **DAPP** calls node API: `POST /api/tg-challenge` with user's Demos address
3. **NODE** generates challenge, stores for 15 minutes: `"DEMOS_TG_BIND_<timestamp>_<nonce>"`
4. **DAPP** prompts user to sign challenge with connected wallet
5. **DAPP** shows signed message: "Send this to @DemosBot: `<signed_challenge>`"
6. **USER** copies and sends signed challenge to Telegram bot
7. **BOT** (separate repo) receives message, creates attestation:
   ```json
   {
     "telegram_id": "123456789",
     "username": "john_doe", 
     "signed_challenge": "0x...",
     "timestamp": 1234567890,
     "bot_address": "0xbot_demos_address",
     "bot_signature": "0x..." // Bot signs the entire attestation
   }
   ```
8. **BOT** calls node API: `POST /api/tg-verify` with attestation
9. **NODE** verifies both signatures, creates unsigned identity transaction, returns to bot
10. **BOT** shows unsigned transaction to user: "Sign this to complete Telegram verification"
11. **USER** signs transaction with wallet and submits to node
12. **NODE** processes signed identity transaction through normal identity system

## Files to Create/Edit

### New Files to Create:
1. `/src/libs/identity/tools/telegram.ts` - Telegram verification logic
2. `/src/api/routes/telegram.ts` - API endpoints for challenge generation and verification
3. `/src/types/telegram.ts` - TypeScript types for Telegram verification

### Files to Edit:
1. `/src/libs/blockchain/gcr/gcr_routines/identityManager.ts` - Update filterConnections method
2. `/src/libs/blockchain/gcr/gcr_routines/IncentiveManager.ts` - Add Telegram incentive methods  
3. `/src/libs/blockchain/gcr/gcr_routines/GCRIdentityRoutines.ts` - Add Telegram context support
4. `/src/api/routes/index.ts` - Add Telegram routes

## Implementation Phases by Repository

### 🏗️ NODE REPOSITORY (This Repo) - All Phases ✅ **COMPLETED**

#### Phase 1: Create Challenge Storage & Types ✅ **COMPLETED**
**Goal**: Set up challenge management and TypeScript types

**File**: `/src/types/telegram.ts`
```typescript
export interface TelegramChallenge {
    challenge: string
    demos_address: string
    timestamp: number
    used: boolean
}

export interface TelegramVerificationRequest {
    telegram_id: string
    username: string
    signed_challenge: string
    timestamp: number
    bot_address: string
    bot_signature: string
}

export interface TelegramIdentityData {
    userId: string
    username: string
    timestamp: number
}
```

**Genesis Block Authorization**:
- **No environment variables needed!** 🎯
- Authorized bot addresses are read from genesis block (`data/genesis.json`)
- Uses existing `Chain.getGenesisBlock()` method
- Current genesis addresses that can be used by bots:
  ```
  0x10bf4da38f753d53d811bcad22e0d6daa99a82f0ba0dbbee59830383ace2420c
  0x51322c62dcefdcc19a6f2a556a015c23ecb0ffeeb8b13c47e7422974616ff4ab
  0xf7a1c3417e39563ca8f63f2e9a9ba08890888695768e95e22026e6f942addf23
  0x3e0d0c734d52540842e104c6a3fc2316453adda9b6042492e74da9687ecc8caa
  0xbf5a666b92751be3e1731bb7be6551ff66fab39c796bc8f26ffaff83fc553b15
  0x6d06e0cbf2c245aa86f4b7416cb999e434ffc66d92fa40b67f721712592b4aac
  ```

**Challenge Storage**: Implement in-memory or Redis store for challenges (15-minute TTL)

#### Phase 2: Create Telegram Tool & API Endpoints ✅ **COMPLETED**
**Goal**: Implement challenge generation and verification logic + REST endpoints

**File**: `/src/libs/identity/tools/telegram.ts`
```typescript
export class Telegram {
    private static instance: Telegram
    private challenges: Map<string, TelegramChallenge> = new Map()
    private authorizedBots: string[] = []
    private lastGenesisCheck: number = 0

    constructor() {
        // No env variables needed - reads from genesis block
    }

    // Load authorized bot addresses from genesis block
    async getAuthorizedBots(): Promise<string[]> {
        // Cache for 1 hour since genesis never changes
        if (Date.now() - this.lastGenesisCheck < 3600000 && this.authorizedBots.length > 0) {
            return this.authorizedBots
        }

        try {
            const genesisBlock = await Chain.getGenesisBlock()
            const genesisData = JSON.parse(genesisBlock.content || '{}')
            
            // Extract addresses from balances array
            this.authorizedBots = genesisData.balances?.map((balance: [string, string]) => balance[0]) || []
            this.lastGenesisCheck = Date.now()
            
            return this.authorizedBots
        } catch (error) {
            log.error('Failed to load authorized bots from genesis', error)
            return []
        }
    }

    async isAuthorizedBot(botAddress: string): Promise<boolean> {
        const authorizedBots = await this.getAuthorizedBots()
        return authorizedBots.includes(botAddress.toLowerCase())
    }

    // Generate challenge for dApp
    generateChallenge(demosAddress: string): string {
        const timestamp = Math.floor(Date.now() / 1000)
        const nonce = crypto.randomBytes(16).toString('hex')
        const challenge = `DEMOS_TG_BIND_${timestamp}_${nonce}`
        
        // Store for 15 minutes
        this.challenges.set(challenge, {
            challenge,
            demos_address: demosAddress,
            timestamp,
            used: false
        })

        setTimeout(() => this.challenges.delete(challenge), 15 * 60 * 1000)
        return challenge
    }

    // Verify bot attestation and user signature
    async verifyAttestation(request: TelegramVerificationRequest): Promise<{
        success: boolean
        message: string
        demosAddress?: string
        telegramData?: TelegramIdentityData
    }> {
        // 1. Check if bot address is authorized (from genesis)
        if (!(await this.isAuthorizedBot(request.bot_address))) {
            return { success: false, message: 'Unauthorized bot address' }
        }
        
        // 2. Verify bot signature
        // 3. Check challenge exists and not expired/used
        // 4. Verify user signature against challenge
        // 5. Mark challenge as used
        // 6. Return verification result
    }

    static getInstance(): Telegram
}
```

**File**: `/src/api/routes/telegram.ts`
```typescript
// POST /api/tg-challenge
// Body: { demos_address: "0x..." }
// Response: { challenge: "DEMOS_TG_BIND_..." }

// POST /api/tg-verify  
// Body: TelegramVerificationRequest
// Response: { success: boolean, unsignedTransaction?: Transaction, message: string }
```

**Integration**: Update `/src/api/routes/index.ts` to include telegram routes

#### Phase 3: Update Identity System ✅ **COMPLETED**
**Goal**: Integrate with existing identity and incentive systems

**Files to Update**:
1. `/src/libs/blockchain/gcr/gcr_routines/identityManager.ts` - Allow Telegram as alternative to Twitter
2. `/src/libs/blockchain/gcr/gcr_routines/IncentiveManager.ts` - Add Telegram incentive methods
3. `/src/libs/blockchain/gcr/gcr_routines/GCRIdentityRoutines.ts` - Add Telegram context support

**Changes**:
```typescript
// identityManager.ts - Update filterConnections method (around line 73)
const twitterAccounts = account.identities.web2["twitter"] || []
const telegramAccounts = account.identities.web2["telegram"] || []

if (twitterAccounts.length === 0 && telegramAccounts.length === 0) {
    return {
        success: false,
        message: "Error: No Twitter or Telegram account found. Please connect a social account first"
    }
}

// IncentiveManager.ts - Add methods
static async telegramLinked(demosAddress: string, telegramUserId: string, referralCode?: string): Promise<void>
static async telegramUnlinked(demosAddress: string): Promise<void>

// GCRIdentityRoutines.ts - Add telegram context in applyWeb2IdentityAdd (around line 237)
} else if (context === "telegram") {
    // Award incentive points for first-time linking
}
```

**Node Repository Total Time: 3 hours**

---

### 📱 DAPP REPOSITORY - 2 Phases

#### Phase A: Add Telegram Link Button & Challenge Flow (1 hour) 📋 **TODO FOR DAPP TEAM**
**Goal**: Add UI components and API integration for Telegram linking

**Tasks**:
1. **Add "Link Telegram" Button**: Next to existing Twitter link button
2. **Challenge Generation**: Call `POST /api/tg-challenge` with user's Demos address
3. **Auto-Sign Challenge**: Use connected wallet to sign the challenge automatically
4. **Display Instructions**: Show user the signed message with clear instructions:
   ```
   "Send this message to @DemosBot on Telegram:
   
   0x1234567890abcdef... (signed challenge)
   
   [Copy to Clipboard] [Open Telegram]"
   ```

**API Integration**:
```typescript
// Call node API to generate challenge
const response = await fetch('/api/tg-challenge', {
    method: 'POST',
    body: JSON.stringify({ demos_address: userAddress })
})
const { challenge } = await response.json()

// Sign challenge with wallet
const signedChallenge = await wallet.signMessage(challenge)

// Show user the signed challenge to send to bot
```

#### Phase B: Add Telegram Identity Display (30 mins) 📋 **TODO FOR DAPP TEAM**
**Goal**: Show linked Telegram accounts in user profile/settings

**Tasks**:
1. **Display Linked Telegram**: Show username/ID in identity section
2. **Unlink Functionality**: Add button to unlink Telegram account
3. **Status Indicators**: Show verification status, points earned

**dApp Repository Total Time: 1.5 hours**

---

### 🤖 TELEGRAM BOT REPOSITORY - 2 Phases

#### Phase X: Message Handling & Signature Verification (1 hour) 📋 **TODO FOR BOT TEAM**
**Goal**: Receive signed challenges and verify them

**Tasks**:
1. **Message Handler**: Detect when users send signed challenges (hex strings starting with 0x)
2. **Basic Validation**: 
   - Check message format looks like signed challenge
   - Rate limiting per user (max 5 attempts per hour)
3. **User Feedback**: 
   ```
   ✅ "Verification received! Processing..."
   ❌ "Invalid format. Please send the signed message from the dApp."
   ```

**Bot Code**:
```python
@bot.message_handler(func=lambda message: message.text.startswith('0x'))
def handle_signed_challenge(message):
    tg_user_id = message.from_user.id
    tg_username = message.from_user.username
    signed_challenge = message.text.strip()
    
    # Rate limiting check
    if check_rate_limit(tg_user_id):
        bot.reply_to(message, "❌ Too many attempts. Please wait before trying again.")
        return
    
    # Send to verification phase
    verify_and_submit(tg_user_id, tg_username, signed_challenge, message)
```

#### Phase Y: Node Verification & Attestation (1.5 hours) 📋 **TODO FOR BOT TEAM**
**Goal**: Create bot attestation and submit to node

**Tasks**:
1. **Bot Wallet Setup**: Configure bot with private key for one of the genesis addresses:
   ```
   # Bot must have private key for ONE of these genesis addresses:
   0x10bf4da38f753d53d811bcad22e0d6daa99a82f0ba0dbbee59830383ace2420c
   0x51322c62dcefdcc19a6f2a556a015c23ecb0ffeeb8b13c47e7422974616ff4ab
   0xf7a1c3417e39563ca8f63f2e9a9ba08890888695768e95e22026e6f942addf23
   0x3e0d0c734d52540842e104c6a3fc2316453adda9b6042492e74da9687ecc8caa
   0xbf5a666b92751be3e1731bb7be6551ff66fab39c796bc8f26ffaff83fc553b15
   0x6d06e0cbf2c245aa86f4b7416cb999e434ffc66d92fa40b67f721712592b4aac
   ```
2. **Create Attestation**: Sign the verification data with bot's genesis private key
3. **Submit to Node**: Call `POST /api/tg-verify` with dual signatures
4. **Handle Responses**: Provide user feedback based on node response

**Bot Code**:
```python
def verify_and_submit(tg_user_id, tg_username, signed_challenge, message):
    # Create attestation payload
    attestation = {
        'telegram_id': str(tg_user_id),
        'username': tg_username or '',
        'signed_challenge': signed_challenge,
        'timestamp': int(time.time())
    }
    
    # Sign attestation with bot's genesis private key
    attestation_json = json.dumps(attestation, sort_keys=True)
    bot_signature = sign_message(attestation_json, GENESIS_PRIVATE_KEY)  # Must be genesis key!
    
    # Submit to node
    payload = {
        **attestation,
        'bot_address': GENESIS_ADDRESS,  # Must match genesis address!
        'bot_signature': bot_signature
    }
    
    response = requests.post(f'{NODE_URL}/api/tg-verify', json=payload)
    
    if response.status_code == 200:
        data = response.json()
        unsigned_tx = data.get('unsignedTransaction')
        
        if unsigned_tx:
            # NEW: Show user the unsigned transaction to sign
            bot.reply_to(message, 
                f"✅ Verification successful! Please sign this transaction to complete linking:\n\n"
                f"Transaction: {json.dumps(unsigned_tx, indent=2)}\n\n"
                f"Sign this with your wallet and submit to complete Telegram identity binding."
            )
        else:
            bot.reply_to(message, "✅ Telegram account successfully linked!")
    else:
        error_msg = response.json().get('message', 'Verification failed')
        bot.reply_to(message, f"❌ Verification failed: {error_msg}")
```

**Bot Repository Total Time: 2.5 hours**

---

## 🚀 Deployment Coordination

### Repository Dependencies:
1. **Node** must be deployed first (provides APIs)
2. **dApp** can be updated anytime after Node (consumes APIs)  
3. **Bot** can be updated anytime after Node (consumes APIs)

### Testing Coordination:
1. **Node Team**: Test APIs with mock data
2. **dApp Team**: Test with Node APIs using test challenges
3. **Bot Team**: Test with Node APIs using test signatures
4. **Integration Test**: All teams test complete flow together

### Total Implementation Time:
- **Node**: 3 hours ⭐ (This repo)
- **dApp**: 1.5 hours 📋 (Other repo)
- **Bot**: 2.5 hours 📋 (Other repo)
- **Integration/Testing**: 1 hour (All teams)

**Grand Total: ~8 hours across all repositories**

## Bot Integration Contract

**For the separate bot repository**, the node expects:

**Challenge Format**: `DEMOS_TG_BIND_<timestamp>_<nonce>`

**Verification Request Format**:
```json
{
  "telegram_id": "123456789",
  "username": "john_doe",
  "signed_challenge": "0x...", // User's signature of challenge
  "timestamp": 1234567890,
  "bot_address": "0x...", // Bot's Demos address
  "bot_signature": "0x..." // Bot signs JSON.stringify({telegram_id, username, signed_challenge, timestamp})
}
```

**API Endpoint**: `POST https://node/api/tg-verify`

**Response Format** (NEW - Transaction-Based):
```json
{
  "success": true,
  "message": "Telegram identity verified. Please sign the transaction to complete binding.",
  "demosAddress": "0x...",
  "telegramData": {
    "userId": "123456789",
    "username": "john_doe",
    "timestamp": 1702834567
  },
  "unsignedTransaction": {
    "hash": "",
    "content": {
      "type": "identity",
      "from_ed25519_address": "0x...",
      "to": "0x...",
      "amount": 0,
      "data": ["identity", {...}],
      "timestamp": 1702834567,
      "nonce": 0,
      "gcr_edits": []
    },
    "signature": null
  }
}
```

**Bot Must Then**:
1. Show unsigned transaction to user
2. Get user to sign transaction with their wallet
3. Submit signed transaction to node's main endpoint: `POST /` (execute method)

## Security Features

1. **Challenge Expiration**: 15-minute TTL
2. **One-Time Use**: Challenges marked as used after verification
3. **Genesis Block Authorization**: Only genesis addresses can sign as bots (immutable, no env hijacking)
4. **Dual Signature**: Both user and bot signatures required
5. **Rate Limiting**: Max 5 challenges per address per hour
6. **Timestamp Validation**: Bot attestations must be recent (< 5 minutes)
7. **Blockchain Native Security**: Uses Demos blockchain itself as authority source

## Success Criteria ✅ ALL COMPLETED

- [x] dApp can generate challenges via API ✅ **DONE** (`POST /api/tg-challenge`)
- [x] Bot can submit valid verifications and receive unsigned transactions ✅ **DONE** (`POST /api/tg-verify`)
- [x] Invalid submissions are rejected appropriately ✅ **DONE** (Full validation pipeline)
- [x] Node creates proper identity transactions (same format as Twitter) ✅ **DONE** (Transaction-based pattern)
- [x] Transactions process through normal identity system path ✅ **DONE** (GCR integration)
- [x] Incentive points awarded correctly ✅ **DONE** (IncentiveManager integration)
- [x] Both Twitter and Telegram identities coexist ✅ **DONE** (identityManager updated)
- [x] All security validations pass ✅ **DONE** (Dual signature + genesis authorization)
- [x] Genesis block authorization working (no env variables needed) ✅ **DONE** (Immutable bot authority)
- [x] Challenge expiration and cleanup working ✅ **DONE** (15-minute TTL + auto-cleanup)

## Time Estimate

**Total: 4.5 hours** (node-side only)
- Phase 1: 15 mins
- Phase 2: 30 mins  
- Phase 3: 45 mins
- Phase 4: 1 hour
- Phase 5: 30 mins
- Phase 6: 45 mins
- Phase 7: 15 mins
- Phase 8: 1.5 hours

## Notes

- Leverages existing Web2 identity infrastructure
- No database schema changes needed
- Bot implementation is separate - only API contract matters
- Challenge-based approach mirrors Twitter pattern
- All existing Twitter functionality remains unchanged

---

## 🏗️ Quick Reference Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           TELEGRAM IDENTITY FLOW                               │
└─────────────────────────────────────────────────────────────────────────────────┘

   📱 DAPP REPO               🏗️ NODE REPO (THIS)          🤖 BOT REPO
┌─────────────────┐        ┌─────────────────────┐      ┌─────────────────┐
│                 │        │                     │      │                 │
│ [Link Telegram] │───1───▶│ POST /tg-challenge  │      │   @DemosBot     │
│     Button      │        │                     │      │                 │
│                 │        │ Generate Challenge  │      │ 0xABC123...     │
│                 │◀──2────│ "DEMOS_TG_BIND_..." │      │ (signed msg)    │
│                 │        │                     │      │                 │
│ Sign Challenge  │        │                     │      │                 │
│ with Wallet     │        │                     │      │                 │
│                 │        │                     │      │                 │
│ "Send this to   │───3───▶│                     │◀─4──▶│ Handle Message  │
│  @DemosBot:"    │        │                     │      │                 │
│ 0xSIGNED123...  │        │                     │      │ Create Bot      │
│                 │        │                     │      │ Attestation     │
│                 │        │                     │      │                 │
│                 │        │ POST /tg-verify     │◀─5───│ Submit to Node  │
│                 │        │                     │      │                 │
│                 │        │ ✓ Verify Signatures │      │                 │
│                 │        │ ✓ Store Identity    │      │                 │
│                 │        │ ✓ Award Points      │      │                 │
└─────────────────┘        └─────────────────────┘      └─────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                              SECURITY LAYERS                                   │
└─────────────────────────────────────────────────────────────────────────────────┘

  USER SIGNATURE                NODE VERIFICATION           BOT SIGNATURE
┌─────────────────┐           ┌─────────────────────┐      ┌─────────────────┐
│                 │           │                     │      │                 │
│ User signs      │──────────▶│ 1. Check challenge  │◀─────│ Bot signs       │
│ challenge with  │           │    exists & valid   │      │ attestation     │
│ Demos wallet    │           │                     │      │ with bot wallet │
│                 │           │ 2. Verify user sig  │      │                 │
│ Proves: User    │           │                     │      │ Proves: Real    │
│ owns Demos      │           │ 3. Verify bot sig   │      │ Telegram user   │
│ address         │           │                     │      │ sent message    │
│                 │           │ 4. Both valid?      │      │                 │
│                 │           │    → Store mapping  │      │                 │
└─────────────────┘           └─────────────────────┘      └─────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                          IMPLEMENTATION PHASES                                 │
└─────────────────────────────────────────────────────────────────────────────────┘

🏗️ NODE (YOU - 3hrs)          📱 DAPP (1.5hrs)           🤖 BOT (2.5hrs)
┌─────────────────┐           ┌─────────────────┐        ┌─────────────────┐
│                 │           │                 │        │                 │
│ ⭐ Phase 1      │           │ 📋 Phase A      │        │ 📋 Phase X      │
│ Types & Storage │           │ UI Components   │        │ Message Handler │
│    (30 mins)    │           │   (1 hour)      │        │   (1 hour)      │
│                 │           │                 │        │                 │
│ ⭐ Phase 2      │           │ 📋 Phase B      │        │ 📋 Phase Y      │
│ Tool & APIs     │           │ Identity Display│        │ Attestation     │
│   (1.5 hours)   │           │   (30 mins)     │        │  (1.5 hours)    │
│                 │           │                 │        │                 │
│ ⭐ Phase 3      │           │                 │        │                 │
│ Identity System │           │                 │        │                 │
│   (1 hour)      │           │                 │        │                 │
└─────────────────┘           └─────────────────┘        └─────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                           DATA FLOW DIAGRAM                                    │
└─────────────────────────────────────────────────────────────────────────────────┘

User Clicks "Link Telegram"
         │
         ▼
   ┌─────────────┐    POST /tg-challenge     ┌─────────────┐
   │    dApp     │ ─────────────────────────▶│    Node     │
   │             │◀───── challenge ──────────│             │
   └─────────────┘                           └─────────────┘
         │                                          │
         │ Sign challenge                           │ Store challenge
         ▼                                          │ (15 min TTL)
   ┌─────────────┐                                  │
   │   Wallet    │                                  │
   │             │                                  │
   └─────────────┘                                  │
         │                                          │
         │ 0xSIGNED123...                          │
         ▼                                          │
   ┌─────────────┐                                  │
   │ Telegram    │───── Send signed msg ───────┐   │
   │    User     │                             │   │
   └─────────────┘                             ▼   │
                                         ┌─────────────┐
                                         │     Bot     │
                                         │             │
                                         └─────────────┘
                                               │
                                               │ Create attestation
                                               │ Sign with bot key
                                               ▼
                                         POST /tg-verify
                                               │
                                               ▼
                                         ┌─────────────┐
                                         │    Node     │
                                         │ ✓ Verify    │
                                         │ ✓ Store     │
                                         │ ✓ Award     │
                                         └─────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                           FILE STRUCTURE                                       │
└─────────────────────────────────────────────────────────────────────────────────┘

📁 src/
├── 📁 api/routes/
│   ├── telegram.ts              ⭐ NEW - Challenge & verify endpoints
│   └── index.ts                 ⭐ EDIT - Add telegram routes
├── 📁 libs/identity/tools/
│   ├── twitter.ts               (existing)
│   └── telegram.ts              ⭐ NEW - Challenge generation & verification
├── 📁 libs/blockchain/gcr/gcr_routines/
│   ├── identityManager.ts       ⭐ EDIT - Allow Telegram as alternative
│   ├── IncentiveManager.ts      ⭐ EDIT - Add Telegram incentive methods
│   └── GCRIdentityRoutines.ts   ⭐ EDIT - Add Telegram context support
├── 📁 types/
│   └── telegram.ts              ⭐ NEW - TypeScript interfaces
└── .env.example                 ⭐ EDIT - Add AUTHORIZED_TG_BOTS

Legend: ⭐ = You implement | 📋 = Other repos | (existing) = Already exists
```