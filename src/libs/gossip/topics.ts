import { sha256 } from "@noble/hashes/sha2.js"
import type { Message } from "@libp2p/interface"

export const HEIGHTS_TOPIC = "demos/heights/1"
export const BLOCKS_TOPIC = "demos/blocks/1"

export const HEIGHTS_MAX_BYTES = 1024
export const BLOCKS_MAX_BYTES = 1024 * 1024 + 4096

export const GOSSIPSUB_PARAMS = {
    D: 8,
    Dlo: 6,
    Dhi: 12,
    doPX: true,
    allowPublishToZeroTopicPeers: true,
}

/**
 * Content-derived message IDs. Blocks key on the block hash so concurrent
 * shard-member publishes dedup even though their signature sets differ;
 * heights records key on (pubkey, seq).
 */
export function gossipMsgId(msg: Message): Uint8Array {
    const enc = new TextEncoder()
    if (msg.topic === BLOCKS_TOPIC) {
        try {
            const block = JSON.parse(new TextDecoder().decode(msg.data))
            if (typeof block?.hash === "string" && block.hash.length > 0) {
                return enc.encode(`block:${block.hash}`)
            }
        } catch {
            // malformed payload: fall through, validator rejects it
        }
    } else if (msg.topic === HEIGHTS_TOPIC) {
        try {
            const rec = JSON.parse(new TextDecoder().decode(msg.data))
            if (typeof rec?.pubkey === "string" && typeof rec?.seq === "number") {
                return enc.encode(`heights:${rec.pubkey}:${rec.seq}`)
            }
        } catch {
            // malformed payload: fall through, validator rejects it
        }
    }
    return sha256(msg.data)
}
