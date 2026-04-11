/**
 * IMP (Instant Messaging Protocol) shared types
 * Extracted from old/types/IMSession.ts during dead-code cleanup
 */

/** Each message in the IM Session is an ImMessage */
export interface ImMessage {
    message: {
        data: any
        timestamp: number // Unix timestamp
        isEncrypted: boolean // If true (default), the message is encrypted with the receiver's public key
        from: string // Hex representation of the sender's public key
    }
    signature: string // Hex representation of the signed message as sent by the sender
}
