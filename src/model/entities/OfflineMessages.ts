import { Column, Entity, PrimaryGeneratedColumn, Index } from "typeorm"
import { SerializedEncryptedObject } from "@kynesyslabs/demosdk/types"

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