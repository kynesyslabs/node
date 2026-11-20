// Dedup by confirmed block hash only; unverified variants keep their own message IDs.
export const BLOCKS_TOPIC = "demos/blocks/1"
const MAX_VERIFIED = 2048
const MAX_BLOCK_BYTES = 1024 * 1024 + 4096

function shallowObject(data) {
    let i = data[0] === 239 && data[1] === 187 && data[2] === 191 ? 3 : 0
    while (i < data.length && (data[i] === 32 || data[i] === 9 || data[i] === 10 || data[i] === 13)) i++
    if (data[i] !== 123) return false
    let depth = 0
    let inString = false
    let escaped = false
    for (; i < data.length; i++) {
        const byte = data[i]
        if (inString) {
            if (escaped) escaped = false
            else if (byte === 92) escaped = true
            else if (byte === 34) inString = false
        } else if (byte === 34) inString = true
        else if (byte === 123 || byte === 91) {
            if (++depth > 64) return false
        } else if (byte === 125 || byte === 93) depth--
    }
    return true
}

export class BlockPolicy {
    verified = new Map()

    // Called only by the trusted local IPC client after the block is stored or applied.
    remember(hash) {
        if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return
        this.verified.delete(hash)
        this.verified.set(hash, true)
        if (this.verified.size > MAX_VERIFIED) {
            this.verified.delete(this.verified.keys().next().value)
        }
    }

    validate(_peer, msg) {
        if (msg.data.length <= MAX_BLOCK_BYTES && !shallowObject(msg.data)) return "ignore"
        if (this.verified.size > 0 && msg.data.length <= MAX_BLOCK_BYTES) {
            try {
                // Confirmed blocks are deduped by hash.
                const block = JSON.parse(new TextDecoder().decode(msg.data))
                const hash = block?.hash
                if (this.verified.has(hash)) {
                    this.remember(hash)
                    return "ignore"
                }
            } catch {
                // Preserve the application's verdict for malformed new blocks.
            }
        }
        return "accept"
    }
}
