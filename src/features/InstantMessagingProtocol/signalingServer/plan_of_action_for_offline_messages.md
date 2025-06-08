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

# PHASE 1.5: L2PS Falcon Migration (PREREQUISITE) # TODO

### 1.5.1 L2PS Cryptographic Migration # TODO
**CRITICAL DEPENDENCY**: Current L2PS uses RSA (forge.pki.rsa.KeyPair), must migrate to Falcon first:

```typescript
// Current L2PS in parallelNetworks.ts:
private keypair: forge.pki.rsa.KeyPair  // ❌ RSA-based

// Target L2PS:
private falconKeyPair: FalconKeyPair    // ✅ Falcon-based  
```

### 1.5.2 Falcon Integration Points # TODO
- **Replace RSA key generation** with Falcon in `Subnet` class
- **Update L2PS authentication methods** to use Falcon signatures  
- **Migrate existing L2PS instances** (if any) to new Falcon format
- **Update L2PS message signing/verification** to use EnhancedCrypto from PQC module

### 1.5.3 L2PS-Falcon Interface # TODO
```typescript
// New L2PS Falcon interface
interface L2PSFalconKeys {
    publicKey: Uint8Array     // Falcon public key
    privateKey: Uint8Array    // Falcon private key
    uid: string              // L2PS identifier (hash of public key)
}

// Update Subnet class methods:
setFalconPrivateKey(privateKey: Uint8Array): RPCResponse
getFalconPublicKey(): Uint8Array  
signWithFalcon(data: string): string
verifyFalconSignature(data: string, signature: string, publicKey: Uint8Array): boolean
```

### 1.5.4 Backward Compatibility Strategy # TODO
- **Deprecate RSA methods** gracefully
- **Support both formats** during transition period (if needed)
- **Clear migration path** for existing L2PS users

# PHASE 2: L2PS-Integrated Messaging System

## PHASE 2A: L2PS Protocol Integration # TODO

### 2A.1 WebSocket Protocol Updates # TODO
Modify messaging protocol to be L2PS-native:
```typescript
// New message format
interface L2PSMessage {
    type: "message"
    payload: {
        l2ps_id: string                    // REQUIRED - which L2PS subnet
        targetId: string                   // recipient within L2PS
        message: SerializedEncryptedObject // encrypted content
        l2ps_signature?: string            // Falcon signature for L2PS auth
    }
}

// New registration format  
interface L2PSRegisterMessage {
    type: "register"
    payload: {
        clientId: string
        publicKey: Uint8Array
        verification: SerializedSignedObject
        l2ps_memberships: L2PSMembership[]  // which L2PS subnets user belongs to
    }
}

interface L2PSMembership {
    l2ps_id: string
    falcon_public_key: Uint8Array    // PQC key for this specific L2PS
    proof_of_membership: string      // signature proving L2PS membership
}
```

### 2A.2 L2PS Membership Verification # TODO
Integrate with existing PQC/Falcon system:
- Replace RSA-based L2PS auth with Falcon signatures
- Verify L2PS membership during peer registration
- Reject messages from non-members to unauthorized L2PS

### 2A.3 SignalingServer L2PS Logic # TODO
Update core message handling:
```typescript
private async handlePeerMessage(ws: WebSocket, payload: L2PSMessage) {
    // 1. Verify sender is L2PS member
    const senderMembership = await this.verifyL2PSMembership(senderId, payload.l2ps_id)
    if (!senderMembership) throw new Error("Not L2PS member")
    
    // 2. Verify recipient is L2PS member  
    const recipientMembership = await this.verifyL2PSMembership(payload.targetId, payload.l2ps_id)
    if (!recipientMembership) throw new Error("Recipient not L2PS member")
    
    // 3. Store to blockchain (with L2PS context)
    // 4. Store to database (with L2PS context)
    // 5. Deliver if online (L2PS members only)
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
@Entity("l2ps_messages") // Rename table to reflect L2PS-native approach
export class L2PSMessage {
    // ... existing fields ...
    
    @Index()
    @Column("text", { name: "l2ps_id" })
    l2psId: string // REQUIRED - every message belongs to an L2PS
    
    @Column("text", { name: "falcon_signature", nullable: true })
    falconSignature?: string // PQC signature for L2PS verification
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
- Message signature verification using Falcon
- L2PS membership rotation handling
- Audit trails for L2PS membership changes


# TODO (Future Enhancements)
- Add message signature verification for integrity checking
- Add message delivery acknowledgments
- Consider implementing message priority levels
- Add metrics/logging for message delivery statistics

## Implementation Order (FINAL) # TODO
1. ✅ **Phase 1** (Basic offline messaging) - COMPLETED
2. 🔄 **Phase 1.5** (L2PS Falcon Migration) - **PREREQUISITE FOR PHASE 2**
3. 🔄 **Phase 2A** (L2PS Protocol Integration) - WebSocket + membership verification
4. 🔄 **Phase 2B** (Database Integration) - Schema + storage + universal messaging
5. 🔄 **Phase 2C** (GCR Integration) - Consensus-time hash computation  
6. 🔄 **Phase 2D** (Optional Features) - Cleanup + enhanced security