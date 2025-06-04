
● Based on my analysis of the codebase, here's how I would implement
  the TODO at line 367:

  Implementation Plan

  The TODO requires two main features:
  1. Insert messages into the blockchain through the SDK
  2. Support for offline messages with database storage

  1. Blockchain Integration

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
  2. Database Entity for Offline Messages

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

  3. Offline Message Storage Methods

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

  4. Integration Points

  - Register entity: Add OfflineMessage to entities array in
  src/model/datasource.ts
  - Handle peer registration: Call deliverOfflineMessages() when a
  peer registers
  - Transaction type: Add "instantMessage" to supported transaction
  types
  - Import dependencies: Add necessary imports for Transaction,
  Mempool, Cryptography, Hashing, etc.

  This implementation provides both blockchain persistence and
  offline message support while following the existing codebase
  patterns for transactions, database entities, and message handling.