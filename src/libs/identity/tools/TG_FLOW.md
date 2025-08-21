# Telegram Identity Verification System

## ASCII Flow Diagram

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   User Client   │    │  Telegram Bot    │    │  Demos Backend  │
│                 │    │  (Authorized)    │    │   (This Code)   │
└─────────┬───────┘    └─────────┬────────┘    └─────────┬───────┘
          │                      │                       │
          │ 1. Request Challenge │                       │
          ├─────────────────────────────────────────────►│
          │                      │                       │
          │ 2. Challenge Response│                       │
          │◄─────────────────────────────────────────────┤
          │                      │                       │
          │ 3. Sign Challenge    │                       │
          │ (with Demos key)     │                       │
          │                      │                       │
          │ 4. Send to Bot       │                       │
          ├─────────────────────►│                       │
          │                      │                       │
          │                      │ 5. Bot Verification   │
          │                      ├──────────────────────►│
          │                      │                       │
          │                      │ 6. Unsigned TX        │
          │                      │◄──────────────────────┤
          │                      │                       │
          │ 7. Return TX         │                       │
          │◄─────────────────────┤                       │
          │                      │                       │
          │ 8. Sign & Submit TX  │                       │
          ├─────────────────────────────────────────────►│
          │                      │                       │
```

## Data Structures Schema

```
TelegramChallenge {
  challenge: string      // "DEMOS_TG_BIND_{address}_{timestamp}_{nonce}"
  demos_address: string  // User's Demos blockchain address
  timestamp: number      // Unix timestamp when created
  used: boolean         // Whether challenge has been consumed
}

TelegramVerificationRequest {
  bot_address: string        // Ed25519 public key of authorized bot
  telegram_id: string       // Telegram user ID
  username: string           // Telegram username
  signed_challenge: string   // User-signed challenge (challenge:signature)
  timestamp: number          // Request timestamp
  bot_signature: string     // Bot's signature over attestation data
}

TelegramWeb2Payload {
  context: string           // "telegram"
  proof: string            // Bot attestation JSON string
  username: string         // Telegram username
  userId: string          // Telegram user ID
  attestation_id: string  // SHA256 hash of challenge for replay protection
}

TelegramVerificationResponse {
  success: boolean
  message: string
  demosAddress?: string              // User's Demos address (if successful)
  telegramData?: {
    userId: string
    username: string
    timestamp: number
  }
  unsignedTransaction?: Transaction  // Ready for user to sign
}
```

## Security Model

```
┌─────────────────────────────────────────────────────────────┐
│                    GENESIS BLOCK                             │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ Authorized Bot Addresses (Ed25519 Public Keys)         │ │
│  │ - bot1_address: "abc123..."                            │ │
│  │ - bot2_address: "def456..."                            │ │
│  │ - bot3_address: "ghi789..."                            │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  VERIFICATION CHAIN                         │
│                                                             │
│  1. Bot Authorization Check ✓                              │
│     └── Genesis block lookup                               │
│                                                             │
│  2. Challenge Validation ✓                                 │
│     └── Format + Expiry + Usage check                      │
│                                                             │
│  3. Challenge Hash Anti-Replay Protection ✓                │
│     └── SHA256(challenge) embedded in transaction          │
│                                                             │
│  4. Bot Signature Verification ✓                           │
│     └── Ed25519 verify(attestation_data, bot_signature)    │
│                                                             │
│  5. User Signature Verification ✓                          │
│     └── Ed25519 verify(challenge, user_signature)          │
│                                                             │
│  6. Identity Transaction Creation                           │
│     └── Unsigned transaction for blockchain submission     │
└─────────────────────────────────────────────────────────────┘
```

## Challenge Format

```
Challenge Structure:
"DEMOS_TG_BIND_{demos_address}_{timestamp}_{nonce}"

Example:
"DEMOS_TG_BIND_abc123def456_1692345678_9f8e7d6c5b4a3210"

Components:
┌─────────┬─────────────────┬───────────┬─────────────────┐
│ Prefix  │ Demos Address   │ Timestamp │ Random Nonce    │
├─────────┼─────────────────┼───────────┼─────────────────┤
│ DEMOS_  │ User's Ed25519  │ Unix time │ 16-byte hex     │
│ TG_BIND │ public key      │ creation  │ for uniqueness  │
└─────────┴─────────────────┴───────────┴─────────────────┘
```

## State Management

```
Memory Storage (Map<string, TelegramChallenge>):
┌─────────────────────────────────────────────────────┐
│  Challenge Key → Challenge Object                   │
├─────────────────────────────────────────────────────┤
│  "DEMOS_TG_BIND_..."  →  {                         │
│                            challenge: string,       │
│                            demos_address: string,   │
│                            timestamp: number,       │
│                            used: boolean             │
│                          }                          │
└─────────────────────────────────────────────────────┘

Auto-cleanup: 15 minutes TTL per challenge
Cache: Authorized bots (1 hour TTL)
```

---

## System Overview

This code implements a **Telegram identity verification system** for the Demos blockchain network. It allows users to cryptographically bind their Telegram accounts to their Demos blockchain addresses through a secure challenge-response protocol.

### Key Components

**1. Challenge Generation**
- Creates unique challenges with format: `DEMOS_TG_BIND_{address}_{timestamp}_{nonce}`
- 15-minute expiration window
- One-time use only

**2. Bot Authorization**
- Only pre-authorized bots (stored in genesis block) can perform verifications
- Bot addresses are Ed25519 public keys
- Cached for performance (1-hour TTL)

**3. Dual Signature Verification**
- **User Signature**: User signs challenge with their Demos private key
- **Bot Signature**: Bot signs attestation data proving Telegram identity

**4. Identity Transaction Creation**
- Generates unsigned blockchain transaction for identity binding
- Follows Web2 identity pattern used by other platforms (Twitter, etc.)
- User must sign and submit to complete the binding

### Security Features

- **Genesis-based Authorization**: Only pre-approved bots can verify identities
- **Challenge Uniqueness**: Cryptographic nonces prevent replay attacks  
- **Challenge Hash Binding**: SHA256 challenge hash embedded in transactions
- **Anti-Replay Protection**: Transaction validation requires matching challenge hash
- **Dual Verification**: Both user and bot must provide valid signatures
- **Time Limits**: Challenges expire after 15 minutes
- **Single Use**: Each challenge can only be used once
- **Validate Mode Security**: On-chain validation prevents replay of old attestations

### Integration Flow

1. User requests challenge from backend
2. User signs challenge with their Demos private key
3. User submits signed challenge to authorized Telegram bot
4. Bot verifies user's Telegram identity and signs attestation
5. Bot sends verification request to backend
6. Backend validates both signatures and bot authorization
7. Backend generates challenge hash (SHA256) for replay protection
8. Backend returns unsigned identity transaction with embedded challenge hash
9. User signs and submits transaction to blockchain
10. On-chain validation verifies challenge hash matches transaction payload

This creates a trustless bridge between Telegram identities and Demos blockchain addresses, with cryptographic protection against replay attacks.
