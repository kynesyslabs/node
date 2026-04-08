import type { EncryptedPayload } from "./types"

type ProcessMessageResult = {
    success: boolean
    error?: string
    l2psTxHash?: string | null
}

type HistoryResult = {
    messages: Array<Record<string, unknown>>
    hasMore: boolean
}

type QueuedMessage = {
    id: string
    from: string
    encrypted: EncryptedPayload
    messageHash: string
}

export class L2PSMessagingService {
    private static instance: L2PSMessagingService | null = null

    static getInstance(): L2PSMessagingService {
        if (!this.instance) {
            this.instance = new L2PSMessagingService()
        }
        return this.instance
    }

    async processMessage(
        _from: string,
        _to: string,
        _l2psUid: string,
        _messageId: string,
        _messageHash: string,
        _encrypted: EncryptedPayload,
        _recipientOnline: boolean,
    ): Promise<ProcessMessageResult> {
        return { success: true, l2psTxHash: null }
    }

    async getHistory(
        _myKey: string,
        _peerKey: string,
        _l2psUid: string,
        _before?: number,
        _limit = 50,
    ): Promise<HistoryResult> {
        return { messages: [], hasMore: false }
    }

    async getQueuedMessages(
        _toKey: string,
        _l2psUid: string,
    ): Promise<QueuedMessage[]> {
        return []
    }

    async markDelivered(_ids: string[]): Promise<void> {}

    resetOfflineCount(_senderKey: string): void {}
}
