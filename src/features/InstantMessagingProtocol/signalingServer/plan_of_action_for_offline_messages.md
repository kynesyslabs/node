Implementation Plan

  1. Insert messages into the blockchain through the SDK
  2. Support for offline messages with database storage

  1. Blockchain Integration # NOTE DONE

  Create a new transaction type for instant messages and integrate
  with the existing GCR system:

```typescript
  // Add to the handlePeerMessage function
  private async handlePeerMessage(
      ws: WebSocket,
      payload: { targetId: string; message: SerializedEncryptedObject
   },
  ) {
      try {
          const senderId = this.getPeerIdByWebSocket(ws)
          if (!senderId) {
              this.sendError(ws, ImErrorType.REGISTRATION_REQUIRED,
  "You must register before sending messages")
              return
          }

          // Create blockchain transaction for the message
          await this.storeMessageOnBlockchain(senderId,
  payload.targetId, payload.message)

          const targetPeer = this.peers.get(payload.targetId)
          if (!targetPeer) {
              // Store as offline message if target is not online
              await this.storeOfflineMessage(senderId,
  payload.targetId, payload.message)
              this.sendError(ws, ImErrorType.PEER_NOT_FOUND, `Target 
  peer ${payload.targetId} not found - stored as offline message`)
              return
          }

          // Forward to online peer
          targetPeer.ws.send(JSON.stringify({
              type: "message",
              payload: { message: payload.message, fromId: senderId
  },
          }))
      } catch (error) {
          console.error("Error handling peer message:", error)
          this.sendError(ws, ImErrorType.INTERNAL_ERROR, "Failed to 
  process message")
      }
  }

  private async storeMessageOnBlockchain(senderId: string, targetId:
  string, message: SerializedEncryptedObject) {
      const transaction = new Transaction()
      transaction.content = {
          type: "instantMessage",
          from: Buffer.from(senderId, 'hex'),
          to: Buffer.from(targetId, 'hex'),
          amount: 0,
          data: [JSON.stringify({ message, timestamp: Date.now() }),
  null],
          gcr_edits: [],
          nonce: 0,
          timestamp: Date.now(),
          transaction_fee: { network_fee: 0, rpc_fee: 0,
  additional_fee: 0 },
      }

      // Sign and hash transaction
      const signature =
  Cryptography.sign(JSON.stringify(transaction.content),
  getSharedState.identity.ed25519.privateKey)
      transaction.signature = signature as any
      transaction.hash =
  Hashing.sha256(JSON.stringify(transaction.content))

      // Add to mempool
      await Mempool.addTransaction(transaction)
  }
```

# NOTE DONE

  2. Database Entity for Offline Messages # NOTE DONE

  Create
  /home/tcsenpai/kynesys/node/src/model/entities/OfflineMessages.ts:

```typescript
  import { Column, Entity, PrimaryGeneratedColumn, Index } from
  "typeorm"

  @Entity("offline_messages")
  export class OfflineMessage {
      @PrimaryGeneratedColumn({ type: "integer", name: "id" })
      id: number

      @Index()
      @Column("text", { name: "recipient_public_key" })
      recipientPublicKey: string

      @Index()
      @Column("text", { name: "sender_public_key" })
      senderPublicKey: string

      @Column("text", { name: "message_hash", unique: true })
      messageHash: string

      @Column("jsonb", { name: "encrypted_content" })
      encryptedContent: SerializedEncryptedObject

      @Column("text", { name: "signature" })
      signature: string

      @Column("bigint", { name: "timestamp" })
      timestamp: bigint

      @Column("text", { name: "status", default: "pending" })
      status: "pending" | "delivered" | "failed"
  }
  ```

  3. Offline Message Storage Methods # NOTE DONE

  Add these methods to the SignalingServer class:

```typescript
  private async storeOfflineMessage(senderId: string, targetId: 
  string, message: SerializedEncryptedObject) {
      const db = await Datasource.getInstance()
      const offlineMessageRepository =
  db.getDataSource().getRepository(OfflineMessage)

      const messageHash = Hashing.sha256(JSON.stringify({ senderId,
  targetId, message, timestamp: Date.now() }))

      const offlineMessage = offlineMessageRepository.create({
          recipientPublicKey: targetId,
          senderPublicKey: senderId,
          messageHash,
          encryptedContent: message,
          signature: "", // Could add signature for integrity
          timestamp: BigInt(Date.now()),
          status: "pending"
      })

      await offlineMessageRepository.save(offlineMessage)
  }

  private async getOfflineMessages(recipientId: string):
  Promise<OfflineMessage[]> {
      const db = await Datasource.getInstance()
      const offlineMessageRepository =
  db.getDataSource().getRepository(OfflineMessage)

      return await offlineMessageRepository.find({
          where: { recipientPublicKey: recipientId, status: "pending"
   }
      })
  }

  
  // REVIEW Where is this called? Shouldnt it be automatic? If yes, how?

  private async deliverOfflineMessages(ws: WebSocket, peerId: string)
   {
      const offlineMessages = await this.getOfflineMessages(peerId)

      for (const msg of offlineMessages) {
          ws.send(JSON.stringify({
              type: "message",
              payload: {
                  message: msg.encryptedContent,
                  fromId: msg.senderPublicKey,
                  timestamp: Number(msg.timestamp)
              }
          }))

          // Mark as delivered
          const db = await Datasource.getInstance()
          const offlineMessageRepository =
  db.getDataSource().getRepository(OfflineMessage)
          await offlineMessageRepository.update(msg.id, { status:
  "delivered" })
      }
  }
```

  4. Integration Points # NOTE DONE

  - Register entity: Add OfflineMessage to entities array in
  src/model/datasource.ts # NOTE DONE
  
  - Handle peer registration: Call deliverOfflineMessages() when a
  peer registers # NOTE DONE
  - Transaction type: Add "instantMessage" to supported transaction
  types # NOTE DONE
  - Import dependencies: Add necessary imports for Transaction,
  Mempool, Cryptography, Hashing, etc. # NOTE DONE

  This implementation provides both blockchain persistence and
  offline message support while following the existing codebase
  patterns for transactions, database entities, and message handling.

# IMPLEMENTATION STATUS: COMPLETE ✅

All features from this plan have been successfully implemented:
- ✅ Blockchain integration with instantMessaging transaction type
- ✅ Database entity for offline messages (already existed)
- ✅ Offline message storage, retrieval, and delivery methods
- ✅ All integration points completed

# PHASE 1.5: L2PS ML-KEM-AES Integration ✅ READY

### 1.5.1 Unified Cryptographic Architecture ✅ SDK READY
**ARCHITECTURE**: ed25519 for authentication + ML-KEM-AES for L2PS transaction encryption:

```typescript
// Complete quantum-safe L2PS architecture using @kynesyslabs/demosdk:
import { UnifiedCrypto } from "@kynesyslabs/demosdk/encryption"
import { Cryptography } from "@kynesyslabs/demosdk/encryption" // ed25519 auth

// Authentication: ed25519 (proven, fast)
const authSignature = Cryptography.sign(message, ed25519PrivateKey)
const isValid = Cryptography.verify(message, authSignature, ed25519PublicKey)

// L2PS Encryption: ML-KEM-AES (quantum-safe)
const unifiedCrypto = UnifiedCrypto.getInstance(l2ps_uid, masterSeed)
await unifiedCrypto.generateIdentity("ml-kem-aes", derivedSeed)
const encryptedTx = await unifiedCrypto.encrypt("ml-kem-aes", txData, peerPublicKey)
const decryptedTx = await unifiedCrypto.decrypt(encryptedTx)
```

### 1.5.2 Available ML-KEM-AES Capabilities ✅ COMPLETE
**Quantum-safe encryption ready for L2PS transactions**:
- ✅ **Key Encapsulation**: `unifiedCrypto.generateIdentity("ml-kem-aes", seed)`
- ✅ **Encryption**: `unifiedCrypto.encrypt("ml-kem-aes", data, peerPublicKey)`
- ✅ **Decryption**: `unifiedCrypto.decrypt(encryptedObject)`
- ✅ **Shared Secrets**: ML-KEM establishes shared AES keys for subnet access
- ✅ **Performance**: AES symmetric encryption for high-throughput L2PS operations

### 1.5.3 L2PS Architecture: Authentication + Encryption ✅ READY TO CODE
```typescript
// Updated Subnet class with quantum-safe architecture
export class Subnet {
    private unifiedCrypto: UnifiedCrypto
    private subnetMasterSeed: Uint8Array
    
    async initializeMLKEM(ed25519Identity: Uint8Array): Promise<void> {
        // Derive L2PS master seed from ed25519 identity for consistency
        this.subnetMasterSeed = this.deriveSubnetSeed(ed25519Identity, this.uid)
        this.unifiedCrypto = UnifiedCrypto.getInstance(this.uid, this.subnetMasterSeed)
        await this.unifiedCrypto.generateIdentity("ml-kem-aes", this.subnetMasterSeed)
    }
    
    // Replace RSA encryptTransaction with ML-KEM-AES
    async encryptTransaction(transaction: Transaction, peerPublicKey: Uint8Array): Promise<EncryptedTransaction> {
        const txData = new TextEncoder().encode(JSON.stringify(transaction))
        const encryptedObject = await this.unifiedCrypto.encrypt("ml-kem-aes", txData, peerPublicKey)
        return this.createEncryptedTransaction(encryptedObject)
    }
    
    async decryptTransaction(encryptedTx: EncryptedTransaction): Promise<Transaction> {
        const decryptedData = await this.unifiedCrypto.decrypt(encryptedTx.encryptedObject)
        return JSON.parse(new TextDecoder().decode(decryptedData))
    }
    
    getMLKEMPublicKey(): Uint8Array {
        return this.unifiedCrypto.getIdentity("ml-kem-aes").publicKey
    }
}
```

### 1.5.4 Integration Strategy ✅ HYBRID APPROACH
- ✅ **ed25519 Authentication**: Keep proven ed25519 for identity/auth layer
- ✅ **ML-KEM-AES L2PS**: Replace RSA with quantum-safe encryption for L2PS transactions
- ✅ **Unified SDK**: Use UnifiedCrypto for all ML-KEM-AES operations
- ✅ **Backward Compatibility**: Maintain RSA support during transition period

# PHASE 2: L2PS-Integrated Messaging System

## PHASE 2A: L2PS Protocol Integration # TODO

### 2A.1 WebSocket Protocol Updates # TODO
Modify messaging protocol for L2PS with ML-KEM-AES encryption:
```typescript
// L2PS-aware message format
interface L2PSMessage {
    type: "message"
    payload: {
        l2ps_id: string                    // REQUIRED - which L2PS subnet
        targetId: string                   // recipient within L2PS
        message: SerializedEncryptedObject // ML-KEM-AES encrypted L2PS transaction
        auth_signature: string             // ed25519 signature for authentication
    }
}

// Enhanced registration with L2PS capabilities
interface L2PSRegisterMessage {
    type: "register"
    payload: {
        clientId: string
        publicKey: Uint8Array              // ed25519 public key for authentication
        verification: SerializedSignedObject // ed25519 signature proof
        l2ps_memberships: L2PSMembership[]  // ML-KEM public keys for L2PS access
    }
}

interface L2PSMembership {
    l2ps_id: string
    ml_kem_public_key: Uint8Array      // ML-KEM public key for this L2PS subnet
    access_proof: SerializedSignedObject // ed25519 signature proving right to access L2PS
    shared_secret_hash: string         // Hash of encapsulated shared secret for verification
}
```

### 2A.2 L2PS Membership Verification # TODO
Integrate ed25519 authentication with ML-KEM-AES L2PS access:
- Use ed25519 signatures to verify identity and L2PS access rights
- Verify ML-KEM public keys match registered L2PS membership during peer registration
- Reject messages from peers without valid ML-KEM keys for target L2PS
- Validate shared secret derivation for L2PS transaction decryption

### 2A.3 SignalingServer L2PS Logic # TODO
Update core message handling for ML-KEM-AES L2PS transactions:
```typescript
private async handlePeerMessage(ws: WebSocket, payload: L2PSMessage) {
    // 1. Verify ed25519 authentication signature
    const senderId = this.getPeerIdByWebSocket(ws)
    const authValid = Cryptography.verify(
        JSON.stringify(payload.message), 
        payload.auth_signature, 
        this.peers.get(senderId).ed25519PublicKey
    )
    if (!authValid) throw new Error("Invalid authentication")
    
    // 2. Verify sender has ML-KEM access to L2PS
    const senderL2PSAccess = await this.verifyML_KEM_L2PSAccess(senderId, payload.l2ps_id)
    if (!senderL2PSAccess) throw new Error("No L2PS access")
    
    // 3. Verify recipient has ML-KEM access to L2PS
    const recipientL2PSAccess = await this.verifyML_KEM_L2PSAccess(payload.targetId, payload.l2ps_id)
    if (!recipientL2PSAccess) throw new Error("Recipient no L2PS access")
    
    // 4. Store ML-KEM encrypted L2PS transaction to blockchain
    await this.storeL2PSTransactionOnBlockchain(senderId, payload.targetId, payload.message, payload.l2ps_id)
    
    // 5. Store to database with L2PS context
    // 6. Deliver if online (L2PS members with ML-KEM keys only)
}
```

## PHASE 2B: Database & Storage Integration # TODO

### 2B.1 Database Schema Updates # TODO
Mandatory L2PS field (no nullable):
```sql
ALTER TABLE offline_messages ADD COLUMN l2ps_id VARCHAR(255) NOT NULL;
CREATE INDEX idx_l2ps_id ON offline_messages(l2ps_id);
CREATE INDEX idx_l2ps_sender ON offline_messages(l2ps_id, sender_public_key);
CREATE INDEX idx_l2ps_recipient ON offline_messages(l2ps_id, recipient_public_key);
```

### 2B.2 Entity Updates # TODO
```typescript
@Entity("l2ps_messages") // L2PS-native messaging with ML-KEM-AES
export class L2PSMessage {
    // ... existing fields ...
    
    @Index()
    @Column("text", { name: "l2ps_id" })
    l2psId: string // REQUIRED - every message belongs to an L2PS
    
    @Column("text", { name: "ml_kem_encrypted_content" })
    mlKemEncryptedContent: string // ML-KEM-AES encrypted L2PS transaction
    
    @Column("text", { name: "ed25519_auth_signature" })
    ed25519AuthSignature: string // ed25519 signature for authentication
    
    @Column("text", { name: "shared_secret_hash" })
    sharedSecretHash: string // Hash of ML-KEM shared secret for verification
}
```

### 2B.3 Universal Message Storage # TODO
Store ALL messages (online + offline) with L2PS context:
- Modify `handlePeerMessage` to store ALL messages in database
- Status flow: "pending" → "delivered" for all messages
- L2PS-filtered queries for message retrieval

### 2B.4 L2PS-Specific Message Operations # TODO
```typescript
async getMessagesByL2PS(l2psId: string): Promise<L2PSMessage[]>
async getMessagesByL2PSAndStatus(l2psId: string, status: string): Promise<L2PSMessage[]>
async deliverOfflineMessagesForL2PS(ws: WebSocket, peerId: string, l2psId: string)
```

## PHASE 2C: GCR Integration During Consensus # TODO

### 2C.1 Consensus-Time Hash Computation # TODO
Integrate with existing consensus mechanism:
- During block creation, compute message hashes per L2PS
- Add to GCR operations before block finalization
- Ensure atomicity with block consensus process

### 2C.2 Per-L2PS Message Digest # TODO
```typescript
// During consensus, for each L2PS:
interface L2PSMessageDigest {
    l2ps_id: string
    message_count: number
    messages_hash: string        // hash of all messages in this block for this L2PS
    participants: string[]       // list of L2PS members who sent messages
}
```

### 2C.3 GCR Schema Integration # TODO
```typescript
// Add to GCR operations during consensus
{
    type: "instantMessagingDigest",
    data: {
        block_number: number,
        l2ps_digests: L2PSMessageDigest[],    // per-L2PS hashes
        combined_hash: string,                // hash of all L2PS digests
        total_messages: number,
        timestamp: number
    }
}
```

### 2C.4 Consensus Integration Points # TODO
- Hook into existing block creation process
- Compute message digests before block finalization
- Add GCR entry atomically with block consensus
- Ensure hash consistency across all nodes

## PHASE 2D: Optional Features # TODO

### 2D.1 Message Cleanup Logic # TODO
- Add sharedState flag for cleanup (disabled by default)
- Implement retention period logic (configurable)
- L2PS-aware cleanup (respect L2PS-specific retention policies)

### 2D.2 Enhanced Security # TODO
- Message authentication using ed25519 signatures
- ML-KEM key rotation for L2PS subnets
- Audit trails for L2PS membership and key changes
- Quantum-safe forward secrecy with ML-KEM key refresh


# TODO (Future Enhancements)
- Add message signature verification for integrity checking
- Add message delivery acknowledgments
- Consider implementing message priority levels
- Add metrics/logging for message delivery statistics

## Implementation Order (UPDATED) # TODO
1. ✅ **Phase 1** (Basic offline messaging) - COMPLETED
2. ✅ **Phase 1.5** (L2PS ML-KEM-AES Integration) - **SDK READY, HYBRID ARCHITECTURE**
3. 🔄 **Phase 2A** (L2PS Protocol Integration) - WebSocket + ML-KEM access verification  
4. 🔄 **Phase 2B** (Database Integration) - Schema + ML-KEM encrypted storage
5. 🔄 **Phase 2C** (GCR Integration) - Consensus-time L2PS transaction hashing  
6. 🔄 **Phase 2D** (Optional Features) - Key rotation + enhanced security

## ARCHITECTURE DECISION ✅
**Hybrid Quantum-Safe Design**: 
- **ed25519 for Authentication**: Proven, fast, maintains existing identity system
- **ML-KEM-AES for L2PS Encryption**: Quantum-safe, high-performance encryption for L2PS transactions
- **UnifiedCrypto Integration**: Ready-to-use ML-KEM-AES implementation from @kynesyslabs/demosdk
- **Backward Compatibility**: RSA support maintained during transition period

## KEY BENEFITS ✅
- **Quantum-Safe L2PS**: ML-KEM-AES protects L2PS transactions against quantum attacks
- **Performance**: AES symmetric encryption ensures high-throughput L2PS operations
- **Shared Secrets**: ML-KEM enables efficient shared-key access control for L2PS subnets
- **Authentication**: ed25519 provides proven, fast identity verification
- **SDK Ready**: Complete implementation available in UnifiedCrypto